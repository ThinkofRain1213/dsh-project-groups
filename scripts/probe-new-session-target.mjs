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

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-new-session-target.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = 17690
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const child = spawn(exe, [BIN, '--profile', 'pg', '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout: ${out.slice(-300)}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (match !== null) { clearTimeout(timer); setTimeout(() => resolve(match[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

// The RPC endpoint is origin-scoped and token-gated; both come off the boot URL.
const origin = new URL(url).origin
const token = new URL(url).searchParams.get('token') ?? ''

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await installRowKeyHelpers(page)
const logs = []
page.on('console', (message) => { if (message.type() === 'error') logs.push(message.text()) })

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Later']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        await button.click({ force: true }).catch(() => {})
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(700)
  }
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
    return { status: response.status, body: await response.text() }
  }, { base: origin, token, value: target })
  await page.waitForTimeout(2500)
  return answer
}

/** Every session id, keyed by the project that owns it (or "(ungrouped)"). */
const owners = async () => {
  const { assignments, projects } = await domain()
  const nameOf = (id) => projects[id]?.title ?? '(unknown)'
  const byOwner = {}
  for (const [sessionId, record] of Object.entries(assignments)) {
    const owner = nameOf(record.projectId)
    byOwner[owner] = [...(byOwner[owner] ?? []), sessionId]
  }
  return byOwner
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
  await row.hover({ timeout: 5000 }).catch(() => {})
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

try {
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
  child.kill()
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
