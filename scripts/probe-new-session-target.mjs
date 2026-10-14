/**
 * Does the shell's New Session button follow the stored destination setting?
 *
 * The button goes through `ui-sidebar` → the `uiWorkspace` service → our vendored
 * `startSession`, which is the one place every unscoped entry converges. So this
 * probe drives the real button with each of the three settings and reads the
 * Host's assignment table, rather than trusting the wiring.
 *
 * ## How the setting is written
 *
 * There is no settings UI yet — that is step 3 — so the probe calls the plugin's
 * own RPC over `/api`, the same endpoint the card will use. Editing the domain
 * file and reloading does **not** work: the Host keeps the parsed global in
 * memory once the domain is open (`storage-domain/src/domain.ts`), so a file
 * change is invisible to the running process. An earlier version of this probe
 * did that and reported failures against working code.
 *
 * Usage: node probe-new-session-target.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { installRowKeyHelpers } from './lib/row-key.mjs'
import { redactToken } from './lib/redact.mjs'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-new-session-target.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

// Overridable: a leftover Host from an aborted run holds the fixed port, and the next probe
// then reports a boot timeout for what is really an occupied port.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17690)
// `join`, not a `\\`-joined literal: on a POSIX runner a backslash is an ordinary filename
// character, so the literal path silently never resolves.
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

let child
let browser
let page
const logs = []

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Later']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        // Logged rather than discarded: a click that never landed leaves the mask up, and the
        // checks below then read an intercepted UI for a setup reason with nothing to say so.
        await button.click({ force: true }).catch((error) => {
          console.log(`  dismiss: click on "${label}" failed — ${error.message}`)
        })
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(700)
  }
  if (await isMasked()) console.log('  dismiss: a modal mask is STILL up after 8 rounds — later checks may be measuring an intercepted UI')
}

const domain = async () => {
  try {
    const text = await readFile(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
    const parsed = JSON.parse(text)
    return { assignments: parsed.tables.assignments ?? {}, projects: parsed.tables.projects ?? {}, global: parsed.global }
  } catch {
    return { assignments: {}, projects: {}, global: undefined }
  }
}

/**
 * Store the destination setting through the plugin's own RPC.
 *
 * `/api/<namespace>/<method>` with the same `{type, rpcId, method, payload}`
 * envelope the client sends — the endpoint the settings card will use in step 3.
 * The Host's answer carries the stored value, which is what makes this an
 * assertion about the write rather than a fire-and-forget.
 */
const setTarget = async (target) => {
  const answer = await page.evaluate(async ({ base, token: key, value }) => {
    const rpcId = `probe-${Math.random().toString(36).slice(2)}`
    const response = await fetch(`${base}/api/projectGroups/setNewSessionTarget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': key },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: 'projectGroups/setNewSessionTarget',
        payload: { args: { request: { target: value } } },
      }),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* reported through status */ }
    return {
      status: response.status,
      ok: parsed?.result?.ok,
      value: parsed?.result?.value,
      error: parsed?.result?.error,
      body: text.slice(0, 200),
    }
  }, { base: origin, token, value: target })
  await page.waitForTimeout(2500)
  // The write is the premise every later assertion rests on, so it is asserted rather than only
  // logged: a rejected call (wrong namespace, 403, non-2xx) left the *previous* setting in force
  // while the checks below still reported PASS — a false green in the probe rewritten to avoid
  // exactly that. The throw is deliberately not used here so the summary below still prints.
  check(`setNewSessionTarget=${target} 写入成功`,
    answer.status === 200 && answer.ok !== false,
    JSON.stringify(answer))
  if (answer.status !== 200 || answer.ok === false) {
    console.log(`  ⚠ 设置未写入（${target}），以下判定可能读到的是陈旧设置`)
  }
  return answer
}

const sessionsUnder = (headingText) => page.evaluate((text) => {
  const section = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .find(node => (node.textContent ?? '').includes(text))
  if (section === undefined) return []
  const scope = section.closest('div[class*="groupSection"]') ?? section.parentElement
  return [...scope.querySelectorAll('[data-row-key^="session:"]')]
    .map(node => window.__sessionIdOf(node.getAttribute('data-row-key')) ?? '')
}, headingText)

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()

const makeProject = async (title) => {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

/** The shell's own New Session control, and the sidebar's ＋ beside the project list. */
const clickTopNew = async () => {
  await dismiss()
  const button = page.locator('button[aria-label="新建会话"]').first()
  await button.click({ force: true })
  await page.waitForTimeout(4500)
}
const clickPlus = async (row) => {
  await dismiss()
  // Logged rather than discarded: when the row is not hoverable (mask still up, row not
  // mounted) the probe used to continue in an inconsistent UI state and then report a product
  // failure for what was a broken setup.
  await row.hover({ timeout: 5000 }).catch((error) => {
    console.log(`  clickPlus: hover failed — ${error.message}`)
  })
  await page.waitForTimeout(400)
  await row.locator('button[aria-label^="在"]').first().dispatchEvent('click')
  await page.waitForTimeout(4500)
}

/** The Session the browser renders as the unstarted one ("新会话"). */
const blankSessionId = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-row-key^="session:"]')]
    .find(node => (node.textContent ?? '').includes('新会话'))
  return window.__sessionIdOf(row?.getAttribute('data-row-key'))
})

/**
 * Where the Session the top button just opened is filed.
 *
 * Tracked by identity rather than by counting: `reuseOrCreateBlank` reuses the
 * Workspace's single blank Session, and every project shares one Workspace, so a
 * click *moves* that Session rather than adding one. A count-based assertion
 * would read the same on a broken build — the earlier probe did exactly that and
 * reported three failures against working code.
 */
const blankOwner = async () => {
  const id = await blankSessionId()
  if (id === null) return { id: null, owner: undefined }
  const { assignments, projects } = await domain()
  const record = assignments[id]
  return { id, owner: record === undefined ? undefined : projects[record.projectId]?.title }
}

let origin = ''
let token = ''

try {
  // Spawned inside the `try` so the `finally` always reaches `child.kill()`. While this sat above
  // the `try`, a boot timeout — or any throw out of `chromium.launch` — rejected the top-level
  // await before cleanup ran and left the Host running on the port.
  child = spawn(exe, [BIN, '--profile', 'pg', '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`boot timeout: ${redactToken(out.slice(-300))}`)), 120_000)
    // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
    // stdout, so without this handler the promise stayed pending until the 120 s timeout and
    // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
    // the process outright.
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`spawn failed for ${exe}: ${error.message}`))
    })
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) { clearTimeout(timer); setTimeout(() => resolve(match[1]), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
  })

  // The RPC endpoint is origin-scoped and token-gated; both come off the boot URL.
  origin = new URL(url).origin
  token = new URL(url).searchParams.get('token') ?? ''

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Installed here, after `page` exists. These two calls used to sit above the `try` on the
  // `let page` declaration — `page` was still `undefined`, so `addInitScript` threw immediately
  // and, had it not, `window.__sessionIdOf` would have been missing from every later read.
  await installRowKeyHelpers(page)
  page.on('console', (message) => { if (message.type() === 'error') logs.push(message.text()) })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  const stamp = Date.now().toString(36)
  const alpha = `甲${stamp}`
  await makeProject(alpha)
  await dismiss()

  // Seed: 甲 gets a Session through its own ＋, which also makes it the project
  // with activity — so `recent` and `current` both have an answer to give.
  await clickPlus(projectRow(alpha))
  const seeded = await blankOwner()
  console.log(`after 甲's ＋: ${JSON.stringify(seeded)}`)
  check('the project ＋ files its Session under 甲',
    seeded.owner === alpha, JSON.stringify(seeded))

  // ── Setting: ungrouped ──
  console.log(`set target=ungrouped: ${JSON.stringify(await setTarget('ungrouped'))}`)
  await clickTopNew()
  const afterUngrouped = await blankOwner()
  const ungroupedRows = await sessionsUnder('未分组')
  console.log(`after the top New Session (ungrouped): ${JSON.stringify(afterUngrouped)}`)
  console.log(`未分组 rows: ${JSON.stringify(ungroupedRows)}`)
  check('with "ungrouped", the top button files nothing',
    afterUngrouped.owner === undefined, JSON.stringify(afterUngrouped))
  check('and the Session renders under Ungrouped',
    afterUngrouped.id !== null && ungroupedRows.includes(afterUngrouped.id),
    JSON.stringify({ afterUngrouped, ungroupedRows }))

  // ── Setting: recent ──
  console.log(`set target=recent: ${JSON.stringify(await setTarget('recent'))}`)
  await clickTopNew()
  const afterRecent = await blankOwner()
  console.log(`after the top New Session (recent): ${JSON.stringify(afterRecent)}`)
  check('with "recent", the top button files under the most recently active project',
    afterRecent.owner === alpha, JSON.stringify(afterRecent))

  // ── Setting: current ──
  // The current Session is the blank one, which is now in 甲 — so `current` and
  // `recent` agree here. The phase below separates them.
  console.log(`set target=current: ${JSON.stringify(await setTarget('current'))}`)
  await clickTopNew()
  const afterCurrent = await blankOwner()
  console.log(`after the top New Session (current): ${JSON.stringify(afterCurrent)}`)
  check('with "current", the top button files under the current Session\'s project',
    afterCurrent.owner === alpha, JSON.stringify(afterCurrent))

  // ── current vs recent, told apart ──
  //
  // The two agree whenever the current Session sits in the most recently active
  // project, which is every case above — so those checks pass on a build that
  // ignores the setting entirely. To separate them the two answers must differ:
  // an empty project created *after* the current Session's last activity wins
  // `recent` (an empty project falls back to its own `createdAt`, which is the
  // Host's rule) while `current` still names 甲.
  const gamma = `丙${stamp}`
  await makeProject(gamma)
  await dismiss()

  console.log(`set target=current: ${JSON.stringify(await setTarget('current'))}`)
  await clickTopNew()
  const currentBeatsRecent = await blankOwner()
  console.log(`"current" with a newer empty project present: ${JSON.stringify(currentBeatsRecent)}`)
  check('"current" ignores a newer empty project',
    currentBeatsRecent.owner === alpha, JSON.stringify(currentBeatsRecent))

  console.log(`set target=recent: ${JSON.stringify(await setTarget('recent'))}`)
  await clickTopNew()
  const recentWins = await blankOwner()
  console.log(`"recent" with a newer empty project present: ${JSON.stringify(recentWins)}`)
  check('"recent" picks the newer empty project',
    recentWins.owner === gamma, JSON.stringify(recentWins))
  check('so the two settings really differ',
    currentBeatsRecent.owner !== recentWins.owner,
    JSON.stringify({ currentBeatsRecent, recentWins }))

  // ── The setting is durable, and it did not eat the project order. ──
  const persisted = await domain()
  console.log(`stored global: ${JSON.stringify(persisted.global)}`)
  check('the setting is stored on the Host',
    persisted.global?.newSessionTarget === 'recent', JSON.stringify(persisted.global))
  check('and the project order survived alongside it',
    Object.keys(persisted.projects).length === 2, JSON.stringify(Object.keys(persisted.projects)))

  console.log(`\nconsole errors: ${logs.length === 0 ? '(none)' : logs.slice(0, 5).join(' | ')}`)
} finally {
  if (child !== undefined) child.kill() // guarded: a synchronous `spawn` throw leaves it unset
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
