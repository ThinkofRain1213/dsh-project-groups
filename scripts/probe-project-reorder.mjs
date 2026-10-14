/**
 * Does dragging a Session inside a project reorder it, and switch to manual?
 *
 * Project rows are not Workspaces: the region's drag commit looked a key up among
 * Workspace ids, found nothing for a project, and returned — so a project's rows
 * could be dragged and would show an insertion marker, but releasing did nothing.
 * Projects are now in the ordering pipeline with their own stored order.
 *
 * This drives the real UI: two Sessions in a project, dragged to swap, with the
 * view menu's ordering mode read before and after.
 *
 * Usage: node probe-project-reorder.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { installRowKeyHelpers, sessionIdOf } from './lib/row-key.mjs'
import { redactToken } from './lib/redact.mjs'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-reorder.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

// Overridable: a leftover process on this port makes the probe connect to the wrong instance
// (or a dead one) and produces misleading PASS/FAIL results rather than an obvious error.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17642)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

function boot(profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let timer
    // Kill before rejecting: `server` is only assigned once this promise resolves, so the
    // caller's `finally` cannot clean up a boot that never returned, and the orphaned Host keeps
    // PORT bound for every later run.
    const fail = (error) => {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      reject(error)
    }
    timer = setTimeout(() => fail(new Error(`timed out booting ${profile}: ${redactToken(out.slice(-400))}`)), 120_000)
    // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
    // stdout, so without this handler the promise stayed pending until the 120 s timeout and
    // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
    // the process outright.
    child.on('error', (error) => fail(new Error(`spawn failed for ${exe}: ${error.message}`)))
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) {
        clearTimeout(timer)
        setTimeout(() => resolve({ child, url: match[1] }), 3000)
      }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('exit', (code) => { fail(new Error(`${profile} exited with ${code}`)) })
  })
}

let browser
let page
const errors = []

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismissModals = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Continue', 'Later', 'Got it', '知道了']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        await button.click({ force: true }).catch(() => {})
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(800)
  }
}

/**
 * Session row locators under one group heading, in rendered order.
 *
 * Scoped to the group: a bare `[data-row-key^="session:"]` matches rows in every
 * group, so an earlier version of this probe dragged a row that belonged
 * somewhere else and read the result as "reordering does nothing".
 */
const sessionRowsUnder = (headingText) => page.evaluate((text) => {
  const section = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .find(node => (node.textContent ?? '').includes(text))
  if (section === undefined) return []
  // The group container, by an explicit class, with the row's own treeitem as the second choice.
  // `section.parentElement` used to be the last-resort fallback, and it can span every group in
  // the tree — the before/after comparison would then include other groups' rows and report a
  // reorder that never happened. Returning `[]` instead turns a missing container into "no
  // rows", which the caller already fails on loudly.
  const scope = section.closest('div[class*="groupSection"]')
    ?? section.closest('div[role="treeitem"]')?.parentElement
  if (scope === undefined || scope === null) return []
  return [...scope.querySelectorAll('[data-row-key^="session:"]')]
    .map(node => node.getAttribute('data-row-key'))
}, headingText)

/** The localStorage key the view mode is persisted under (versioned upstream — bump with it). */
const VIEW_STORE_KEY = 'dsh.workspace.view.v5'

/**
 * The ordering mode, read from the view store that persists it.
 *
 * Reading the menu's DOM would mean guessing which row carries the selection
 * marker; the store is the authoritative record and the menu is a view of it.
 */
const orderMode = () => page.evaluate((key) => {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  // A stale/corrupted value used to escape as a SyntaxError and abort the run instead of
  // reporting a mode.
  try { return JSON.parse(raw).orderBy ?? null } catch { return '<unparseable>' }
}, VIEW_STORE_KEY)

let server
let aborted = null
try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // All three need a live `page`, so they run here and not at module scope: at module scope the
  // helper install and the listeners executed against an undefined `page` and threw before the
  // browser had even launched.
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })
  await installRowKeyHelpers(page)
  server = await boot('pg')
  await page.goto(server.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6000)
  await dismissModals()

  // Two Sessions in one project, so there is something to reorder.
  const unique = `reorder-${Date.now().toString(36)}`
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(unique)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)

  const projectRow = page.locator('[data-row-key^="workspace:"]', { hasText: unique }).first()
  // The project's own ＋ files each new Session under it. Two Sessions are needed,
  // because a project's first ＋ reuses the blank one: the first gets a message so
  // it stops being the reusable blank, then the second is created fresh.
  const createProjectSession = async (message) => {
    await dismissModals()
    await projectRow.hover({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(400)
    await projectRow.locator('button[aria-label^="在"]').first().dispatchEvent('click')
    await page.waitForTimeout(3000)
    if (message === undefined) return
    await dismissModals()
    const composer = page.locator('[data-composer-input="true"]').first()
    if (await composer.count() === 0) return
    await composer.click({ force: true }).catch(() => {})
    await composer.fill(message).catch(() => {})
    await page.keyboard.press('Enter')
    await page.waitForTimeout(7000)
  }
  await createProjectSession('first session')
  await createProjectSession('second session')

  const beforeKeys = await sessionRowsUnder(unique)
  // Parsed Node-side: `sessionRowsUnder` returns row keys (strings), and this map
  // runs outside the page, where the injected `window.__sessionIdOf` does not exist.
  const before = beforeKeys.map(key => sessionIdOf(key) ?? '')
  console.log(`sessions in the project, in order: ${JSON.stringify(before)}`)
  check('the project holds two Sessions', before.length === 2, JSON.stringify(before))
  if (before.length !== 2) throw new Error('cannot reorder without two rows')

  const modeBefore = await orderMode()
  console.log(`ordering mode before: ${JSON.stringify(modeBefore)}`)

  // Drag the second row onto the TOP of the first. The drop side is chosen by
  // comparing the pointer against the row's midpoint (`rowHalf`), so dropping on
  // a row's centre means "after it" — which for row 2 onto row 1 is where the row
  // already is, and the reorder is a no-op that looks like a broken feature.
  // The point is derived from the row's own box (10% down) rather than a bare `y: 1`, so a
  // padding/line-height change cannot silently move it past the midpoint and turn the drop into
  // a no-op that is then reported as a product failure.
  const scoped = projectRow.locator('xpath=ancestor::div[contains(@class,"groupSection")]')
    .locator('[data-row-key^="session:"]')
  const source = scoped.nth(1)
  const target = scoped.nth(0)
  check('both rows are addressable for the drag',
    await source.count() > 0 && await target.count() > 0,
    `source=${await source.count()} target=${await target.count()}`)
  const targetBox = await target.boundingBox()
  if (targetBox === null) throw new Error('the target row is not laid out')
  await source.dragTo(target, {
    targetPosition: { x: Math.round(targetBox.width / 2), y: Math.max(1, Math.round(targetBox.height * 0.1)) },
    timeout: 20_000,
  })
  await page.waitForTimeout(3000)

  const after = (await sessionRowsUnder(unique)).map(key => sessionIdOf(key) ?? '')
  console.log(`sessions in the project, after the drag: ${JSON.stringify(after)}`)
  check('the drag reordered the project\'s Sessions',
    after.length === 2 && after[0] === before[1] && after[1] === before[0],
    JSON.stringify({ before, after }))

  // The drag is a sort gesture, so it selects manual ordering — upstream's rule.
  const modeAfter = await orderMode()
  console.log(`ordering mode after: ${JSON.stringify(modeAfter)}`)
  check('the drag switched ordering to manual', modeAfter === 'manual',
    JSON.stringify({ modeBefore, modeAfter }))

  // Reload: the order is on the Host, so it must come back.
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismissModals()
  const reloaded = (await sessionRowsUnder(unique)).map(key => sessionIdOf(key) ?? '')
  console.log(`sessions after reload: ${JSON.stringify(reloaded)}`)
  check('the new order survives a reload (it is on the Host)',
    reloaded.length === 2 && reloaded[0] === before[1] && reloaded[1] === before[0],
    JSON.stringify(reloaded))

  // Collected page errors are a real assertion, not just a printed line: the probe used to
  // report ALL CHECKS PASSED while the page had thrown. Console *messages* stay diagnostics —
  // the dev server legitimately logs some — but an uncaught page exception never is.
  console.log(`\nconsole errors: ${errors.length === 0 ? '(none)' : errors.join(' | ')}`)
  check('the page threw no uncaught error during the run',
    !errors.some(entry => entry.startsWith('pageerror:')),
    errors.filter(entry => entry.startsWith('pageerror:')).join(' | ') || '(none)')
} catch (error) {
  // The guards above (`cannot reorder without two rows`, `the target row is not laid out`) and
  // any rejected page call used to escape the `try` and skip the summary and the exit code, so
  // the probe's outcome was an uncaught exception rather than its own bookkeeping.
  aborted = error
  check('the run completed without an unexpected abort', false, String(error?.message ?? error))
} finally {
  if (server?.child !== undefined && server.child.exitCode === null) {
    server.child.kill()
    await new Promise(resolve => setTimeout(resolve, 4000))
  }
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
if (aborted !== null) console.log(`  运行在断言中途终止: ${String(aborted?.message ?? aborted)}`)
process.exit(failures.length === 0 ? 0 : 1)
