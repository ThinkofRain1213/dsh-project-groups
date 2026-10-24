/**
 * Does `recent` stop letting the blank New Session choose its own destination?
 *
 * The defect: `reuseOrCreateBlank` reuses the Workspace's single blank Session, so
 * the Session being placed is already in the Session list — with its own creation
 * time — and it carries whatever project it was last filed under. Counting that
 * row as activity handed that project a fresh timestamp it did no work for, so
 * `recent` kept landing in the same project.
 *
 * ## The discriminating scenario
 *
 * Two projects, both with no Sessions of their own, and a blank Session parked in
 * 甲 by clicking 甲's ＋. Their `createdAt`s are then rewritten so that 乙 is the
 * newer project, which is the only fact that should decide the answer:
 *
 *   project 甲  createdAt = 2019   (holds a blank Session whose time is "now")
 *   project 乙  createdAt = 2021   (empty)
 *
 *   before the fix: 甲 wins on the blank row's fresh timestamp
 *   after the fix:  the blank is excluded, so 乙 wins on its newer createdAt
 *
 * The rewrite happens on the domain file with the Host stopped, then the Host is
 * restarted: it keeps the parsed global in memory once the domain is open, so a
 * file change is invisible to a running process (measured in step 2).
 *
 * Usage: node probe-recent-blank.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { installRowKeyHelpers } from './lib/row-key.mjs'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-recent-blank.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = 17689
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Boot the profile and resolve once the shell prints its token URL. */
function boot() {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [BIN, '--profile', 'pg', '--port', String(PORT), '--no-open'], {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    // Both reject paths reap the process first: the caller only receives the child on success, so
    // a boot that failed here used to leave a Host holding `PORT` and still writing the domain.
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`boot timeout: ${redactToken(out.slice(-300))}`))
    }, 120_000)
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
      if (match !== null) { clearTimeout(timer); setTimeout(() => resolve({ child, url: match[1] }), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early with ${code}: ${redactToken(out.slice(-300))}`)) })
  })
}

/**
 * Stop the Host, and wait until it is really gone.
 *
 * The blind 4 s sleep that used to be here assumed the process exits promptly. When it does not
 * (a slow shutdown, or a `kill` that does not take effect), it can still flush its in-memory
 * domain afterwards and clobber the Phase 2 `createdAt` rewrite — which then surfaced as the
 * confusing "the rewrite survived the restart" failure rather than as "the Host was still up".
 * @param child - the spawned Host.
 * @param timeoutMs - how long to wait for `exit` before escalating to SIGKILL.
 */
const stop = async (child, timeoutMs = 10_000) => {
  const gone = () => child.exitCode !== null || child.signalCode !== null
  if (gone()) return
  let timer
  const exited = new Promise((resolve) => { child.once('exit', resolve) })
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })
  child.kill()
  const stopped = await Promise.race([exited.then(() => true), timeout.then(() => false)])
  clearTimeout(timer)
  if (stopped || gone()) return
  // Escalate: the caller is about to rewrite the domain file on the assumption that nothing can
  // write it back, so a process that ignored the first signal must not be left running.
  let killTimer
  const killed = new Promise((resolve) => { child.once('exit', resolve) })
  const killTimeout = new Promise((resolve) => { killTimer = setTimeout(resolve, 3000) })
  child.kill('SIGKILL')
  await Promise.race([killed, killTimeout])
  clearTimeout(killTimer)
}

const domainPath = () => join(dshHome, 'storages', 'project_groups.json')
const domain = async () => JSON.parse(await readFile(domainPath(), 'utf8'))

const logs = []
let browser
let page

/**
 * 关掉挡路的弹窗。
 *
 * 收敛到 `lib/boot-dsh.mjs`：原先这份本地副本的标签表里没有「关闭」，
 * 而隔离 profile 首启的登录引导**只有**那个按钮能关掉 —— 于是后面每一次 `makeProject` /
 * `clickPlus` 都会超时在一个与真实原因无关的地方。
 */
const dismiss = () => dismissShared(page)

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()

const makeProject = async (title) => {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

/** Click a project row's ＋, which files the blank Session under it. */
const clickPlus = async (row) => {
  await dismiss()
  const plus = row.locator('button[aria-label^="在"]').first()
  // Resolve the button before dispatching, and report what was clicked: a
  // dispatch against a row that has not rendered its ＋ yet is a silent no-op,
  // which then reads as the placement having failed.
  const label = await plus.getAttribute('aria-label', { timeout: 10_000 }).catch(() => null)
  console.log(`clicking ＋: ${JSON.stringify(label)}`)
  await row.hover({ timeout: 5000 }).catch((error) => { console.log(`  悬停失败: ${error.message}`) })
  await page.waitForTimeout(400)
  await plus.dispatchEvent('click')
  await page.waitForTimeout(4500)
}

/**
 * Wait until the blank Session's owner satisfies `isDone`, then report the last reading.
 *
 * One helper rather than two near-identical loops — "any owner" and "an owner other than X" are
 * the same poll with a different predicate, and a fix to the cadence or the deadline could
 * otherwise land in one copy only. Both callers report the *last* reading even when it still
 * fails the predicate, so the assertion's detail carries the observed value.
 * @param isDone - predicate over `{ id, owner }`.
 * @param timeoutMs - deadline for the poll.
 * @returns the last reading.
 */
const waitForOwner = async (isDone, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let last = await blankOwner()
  while (!isDone(last) && Date.now() < deadline) {
    await page.waitForTimeout(600)
    last = await blankOwner()
  }
  return last
}

/**
 * Wait for the blank Session to carry an assignment, then report its owner.
 *
 * Polled rather than read once: the placement is a Remote round trip and the
 * sidebar re-renders around it, so a fixed sleep races it and reports "no owner"
 * against a working build.
 */
const settledOwner = (timeoutMs = 12_000) => waitForOwner(reading => reading.owner !== undefined, timeoutMs)

/**
 * Wait until the blank Session's owner stops being `from`, then report it.
 *
 * A plain "wait for an owner" is not enough after the seed: the blank is already
 * filed under the first project and stays that way until the placement lands, so
 * the first read would return the old value and the assertion would measure the
 * seed rather than the click.
 */
const ownerAfter = (from, timeoutMs = 15_000) => waitForOwner(reading => reading.owner !== from, timeoutMs)

/** Store the destination over the plugin's own RPC, the endpoint the card uses. */
const setTarget = async (target) => {
  // The response is read and checked.
  //
  // It used to be discarded, so a rejected `setNewSessionTarget` — wrong token, 4xx/5xx, an RPC
  // error envelope — was swallowed and resurfaced later as "the destination is set to recent"
  // failing, or worse as a bogus placement assertion. `probe-new-session-target.mjs` already
  // returns `{ status, body }` from this same call; this mirrors it.
  const result = await page.evaluate(async ({ base, token, value }) => {
    const response = await fetch(`${base}/api/projectGroups/setNewSessionTarget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `probe-${Math.random().toString(36).slice(2)}`,
        method: 'projectGroups/setNewSessionTarget',
        payload: { args: { request: { target: value } } },
      }),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* reported through status */ }
    return { status: response.status, ok: parsed?.result?.ok, error: parsed?.result?.error, text: text.slice(0, 200) }
  }, { base: new URL(page.url()).origin, token: new URL(page.url()).searchParams.get('token') ?? '', value: target })
  check(`前置：setNewSessionTarget(${JSON.stringify(target)}) 成功`,
    result.status === 200 && result.ok !== false,
    `status=${String(result.status)} ok=${String(result.ok)} error=${JSON.stringify(result.error)} body=${result.text}`)
  if (result.status !== 200 || result.ok === false) {
    throw new Error(`setNewSessionTarget(${JSON.stringify(target)}) failed; the assertions below would measure the wrong state`)
  }
  await page.waitForTimeout(2500)
}

/** The Session the sidebar renders as the unstarted one. */
const blankSessionId = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-row-key^="session:"]')]
    .find(node => (node.textContent ?? '').includes('新会话'))
  return window.__sessionIdOf(row?.getAttribute('data-row-key'))
})

const blankOwner = async () => {
  const id = await blankSessionId()
  if (id === null) return { id: null, owner: undefined }
  // Read through `tables`: the domain file's shape is `{ unit, global, tables }`,
  // so a top-level destructure silently yields empty maps and reports "no owner"
  // against a working build.
  const parsed = await domain()
  const assignments = parsed.tables.assignments ?? {}
  const projects = parsed.tables.projects ?? {}
  const record = assignments[id]
  return { id, owner: record === undefined ? undefined : projects[record.projectId]?.title }
}

let running
try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Both need a real page, and both used to run at module scope where `page` was still
  // `undefined`: `installRowKeyHelpers` calls `page.addInitScript`, so the probe threw
  // `Cannot read properties of undefined` before it ever booted the Host.
  await installRowKeyHelpers(page)
  page.on('pageerror', (error) => { logs.push(`pageerror: ${error.message}`) })
  // ── Phase 1: two empty projects, and a blank parked in the first. ──
  // 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
  // 进程存活但从不监听端口 —— 那时下面的 boot 等到的只是一条误导性的超时。
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: 'pg' })
  if (prepared.problem !== undefined) {
    console.error(`无法准备探针环境：${prepared.problem}`)
    process.exit(2)
  }
  running = await boot()
  await page.goto(running.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)

  const stamp = Date.now().toString(36)
  const older = `甲${stamp}`
  const newer = `乙${stamp}`
  await makeProject(older)
  await makeProject(newer)
  await clickPlus(projectRow(older))

  const seeded = await settledOwner()
  console.log(`after ${older}'s ＋: ${JSON.stringify(seeded)}`)
  if (seeded.owner !== older) {
    // Report what the domain actually holds, so a setup failure is not confused
    // with a placement failure.
    const state = await domain()
    console.log(`  assignments: ${JSON.stringify(state.tables.assignments ?? {})}`)
    console.log(`  projects: ${JSON.stringify(Object.entries(state.tables.projects)
      .map(([id, p]) => [p.title, id, p.createdAt]))}`)
  }
  check('the blank Session is filed under the first project',
    seeded.owner === older, JSON.stringify(seeded))

  const beforeEdit = await domain()
  const idOf = (title) => beforeEdit.global.projectIds
    .find(candidate => beforeEdit.tables.projects[candidate]?.title === title)
  console.log(`projects: ${JSON.stringify(beforeEdit.global.projectIds)}`)
  check('both projects exist', idOf(older) !== undefined && idOf(newer) !== undefined,
    JSON.stringify(Object.values(beforeEdit.tables.projects).map(p => p.title)))

  // The ids are resolved once and the run stops here when either is missing. The two statements
  // below used to dereference `projects[undefined]`, which threw a `TypeError` past the summary
  // and exited with a stack trace instead of a clean "CHECK(S) FAILED".
  const olderId = idOf(older)
  const newerId = idOf(newer)
  if (olderId === undefined || newerId === undefined) {
    throw new Error(`both projects must exist before the createdAt rewrite: ${older}=${String(olderId)} ${newer}=${String(newerId)}`)
  }

  // ── Phase 2: rewrite both createdAt values so only the newer project should win. ──
  await stop(running.child)
  const edited = await domain()
  edited.tables.projects[olderId].createdAt = '2019-01-01T00:00:00.000Z'
  edited.tables.projects[newerId].createdAt = '2021-01-01T00:00:00.000Z'
  await writeFile(domainPath(), JSON.stringify(edited), 'utf8')
  console.log(`rewrote createdAt — ${older}=2019, ${newer}=2021`)

  // ── Phase 3: restart, choose `recent`, and click the shell's New Session. ──
  running = await boot()
  await page.goto(running.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  const reloaded = await domain()
  check('the rewrite survived the restart',
    reloaded.tables.projects[olderId].createdAt.startsWith('2019')
      && reloaded.tables.projects[newerId].createdAt.startsWith('2021'),
    JSON.stringify({ older: reloaded.tables.projects[olderId].createdAt, newer: reloaded.tables.projects[newerId].createdAt }))

  await setTarget('recent')
  const stored = await domain()
  check('the destination is set to recent',
    stored.global.newSessionTarget === 'recent', JSON.stringify(stored.global))

  await dismiss()
  await page.locator('button[aria-label="新建会话"]').first().click({ force: true })
  // The blank is filed under `older` from the seed, so wait for the owner to
  // change rather than for any owner at all.
  const landed = await ownerAfter(older)
  console.log(`after the New Session: ${JSON.stringify(landed)}`)
  check('the blank Session no longer decides its own destination',
    landed.owner === newer, JSON.stringify(landed))

  // Asserted, not just printed: a page that throws (the sidebar re-render blowing up) would
  // otherwise end the run with ALL CHECKS PASSED.
  check('页面没有未捕获异常', logs.length === 0, logs.slice(0, 3).join(' | '))

  console.log(`\nconsole errors: ${logs.length === 0 ? '(none)' : logs.slice(0, 5).join(' | ')}`)
} finally {
  // Awaited, not fired and forgotten: `child.kill()` alone lets the script exit before the
  // process is reaped, and `stop()` waits for `exit` (with a SIGKILL escalation) so the Host
  // cannot still be writing the domain after this run ends.
  if (running !== undefined) await stop(running.child)
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
