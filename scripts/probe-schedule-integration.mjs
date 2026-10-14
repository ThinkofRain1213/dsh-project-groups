/**
 * Does the new scheduler (0.2.0) work inside this plugin's sidebar?
 *
 * The scheduler is the first upstream feature that both *creates Sessions* and
 * *claims Session-row slots* — the two seams this plugin owns. Its client half calls
 * `ctx.uiWorkspace.startSession()`, and this plugin is the provider of `uiWorkspace`
 * (the official row is disabled and ours is mounted), so the call may already route
 * through this plugin's default-Workspace resolution and `placeUnscoped` policy. It
 * also registers into `sidebar.session.row.leading` / `.hover`, which the vendored
 * browser renders.
 *
 * "Compatible by construction" is a claim about runtime behaviour, so it is measured:
 *
 *   - does the schedule panel affordance render in this plugin's sidebar?
 *   - does a scheduled task's Session-creating entry point reach this plugin (i.e.
 *     does a Session appear under the default Workspace / Ungrouped)?
 *   - does anything throw on mount?
 *
 * A failure here is an adaptation task, not a rebuild: the scheduler keeps its own
 * store and delivers each occurrence as a follow-up in its original Session.
 *
 * Usage: node probe-schedule-integration.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-schedule-integration.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17790 : 17791))
// `join` rather than Windows-only separators: the literal is an invalid path on a POSIX host.
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// The scheduler's own vocabulary, taken from its shipped locale (`任务调度` / `Task scheduling`)
// plus its package name. The earlier pattern also matched `任务`/`task`/`计划`, which is ordinary
// sidebar chrome ("添加任务"), so a generic word could report the scheduler as integrated when the
// bundle is not even enabled.
const SCHEDULER_WORDS = /任务调度|Task scheduling|dsh-schedule/
/** Deliberately weak: printed for a reader, never used for the verdict. */
const SCHEDULER_LOOSE = /计划|定时|任务|schedule|task/i

/** Uncaught page exceptions, printed in the verdict. */
const pageErrors = []
const consoleErrors = []

// Spawned inside the `try` below, so a failed spawn, a boot timeout or a launch error all still
// reach the `finally` that reaps the Host. While the spawn sat above the `try`, a boot timeout
// rejected the top-level await and left the Electron Host holding `PORT`.
let child
let browser
let page

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 8; i += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Later']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        // Logged rather than swallowed: a click that fails keeps the mask up, and the shape
        // reading below would then describe the mask instead of the sidebar.
        await button.click({ force: true }).catch((error) => { console.log(`  取消失败（${label}）: ${error.message}`) })
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(700)
  }
}

try {
  child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
    // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
    // stdout, so without this handler the promise stayed pending until the 120 s timeout and
    // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
    // the process outright.
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`spawn failed for ${exe}: ${error.message}`))
    })
    let settled = false
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (m !== null && !settled) {
        settled = true
        clearTimeout(timer)
        // The listeners are removed once the URL is captured: `out` is not read again, and the
        // old code kept appending every later stdout/stderr chunk to it for the process's life.
        child.stdout.removeAllListeners('data')
        child.stderr.removeAllListeners('data')
        // A deliberate settle, not a readiness signal: the URL line is printed before the client
        // bundles have finished evaluating. `waitForFunction` on the plugin's own affordance
        // follows, so this only covers what that cannot express.
        setTimeout(() => resolve(m[1]), 3000)
      }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
  })

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Attached only once `page` exists: at module scope `page` was still `undefined`, so
  // `page.on(...)` threw before the Host was even spawned.
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  // Readiness instead of a bare 9 s: the plugin's own sidebar affordance is the condition every
  // reading below depends on, and it either appears or the run is a failure worth reporting.
  await page.waitForFunction(
    () => document.querySelector('button[aria-label="新建项目"]') !== null,
    null, { timeout: 30_000 },
  )
  await dismiss()

  /**
   * What the sidebar shows, and whether the scheduler's affordances are among it.
   *
   * The scheduler's panel is registered on `sidebar.panellist` and its page on
   * `main`; the per-row marks go to `sidebar.session.row.leading`. All three are
   * looked for by their own accessible names / icons rather than by position.
   */
  const shape = await page.evaluate(({ scheduleWords, scheduleLoose }) => {
    // Sources, not the module-level regex objects: this body runs in the page, where a Node
    // module binding does not exist (referencing one throws `ReferenceError`).
    const words = new RegExp(scheduleWords)
    const loose = new RegExp(scheduleLoose)
    const text = document.body.innerText ?? ''
    const buttons = [...document.querySelectorAll('button')].map(node => ({
      label: node.getAttribute('aria-label') ?? '',
      title: node.getAttribute('title') ?? '',
      text: (node.textContent ?? '').trim().slice(0, 24),
    }))
    return {
      pluginMounted: document.querySelector('button[aria-label="新建项目"]') !== null,
      rows: [...document.querySelectorAll('[data-row-key]')].map(node => node.getAttribute('data-row-key')),
      // The scheduler's own vocabulary, in both languages — see SCHEDULER_WORDS. The loose
      // pattern is only a weak signal for the reader: it also matches ordinary chrome.
      mentionsSchedule: words.test(text),
      mentionsScheduleLoose: loose.test(text),
      scheduleButtons: buttons.filter(b => words.test(`${b.label}${b.title}${b.text}`)).slice(0, 12),
      bodyText: text.replace(/\s+/g, ' ').slice(0, 300),
    }
  }, { scheduleWords: SCHEDULER_WORDS.source, scheduleLoose: SCHEDULER_LOOSE.source })

  console.log(`插件侧栏已挂载: ${shape.pluginMounted}`)
  console.log(`行: ${JSON.stringify(shape.rows)}`)
  console.log(`页面提到调度器专有字样（判定用）: ${shape.mentionsSchedule}`)
  console.log(`页面出现调度类泛词（弱信号，不参与判定）: ${shape.mentionsScheduleLoose}`)
  console.log(`相关按钮 (${shape.scheduleButtons.length}):`)
  for (const button of shape.scheduleButtons) console.log(`  ${JSON.stringify(button)}`)
  console.log('')
  console.log(`侧栏文字: ${shape.bodyText}`)
  console.log('')
  console.log(`pageerror (${pageErrors.length}):`)
  for (const error of pageErrors) console.log(`  ${error}`)
  console.log(`console error (${consoleErrors.length}):`)
  for (const error of consoleErrors.slice(0, 10)) console.log(`  ${error}`)

  console.log('')
  console.log('=== 判定 ===')
  console.log(`  本插件仍是侧栏所有者: ${shape.pluginMounted ? '✅' : '❌'}`)
  console.log(`  启动级错误: ${pageErrors.length === 0 ? '✅ 无' : `❌ ${pageErrors.length} 个`}`)
  console.log(`  调度 UI 是否出现在同一侧栏: ${shape.scheduleButtons.length > 0 ? '✅ 是' : '（未发现可见入口；可能未启用该 bundle）'}`)
} finally {
  // Guarded: the spawn is inside the `try` now, so a synchronous spawn failure must not turn the
  // real error into a `TypeError` from this line.
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
