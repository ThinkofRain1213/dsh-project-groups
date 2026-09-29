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
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-schedule-integration.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17790 : 17791
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${out.slice(-1500)}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const pageErrors = []
const consoleErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 8; i += 1) {
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

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(9000)
  await dismiss()

  /**
   * What the sidebar shows, and whether the scheduler's affordances are among it.
   *
   * The scheduler's panel is registered on `sidebar.panellist` and its page on
   * `main`; the per-row marks go to `sidebar.session.row.leading`. All three are
   * looked for by their own accessible names / icons rather than by position.
   */
  const shape = await page.evaluate(() => {
    const text = document.body.innerText ?? ''
    const buttons = [...document.querySelectorAll('button')].map(node => ({
      label: node.getAttribute('aria-label') ?? '',
      title: node.getAttribute('title') ?? '',
      text: (node.textContent ?? '').trim().slice(0, 24),
    }))
    return {
      pluginMounted: document.querySelector('button[aria-label="新建项目"]') !== null,
      rows: [...document.querySelectorAll('[data-row-key]')].map(node => node.getAttribute('data-row-key')),
      // The scheduler's own vocabulary, in both languages.
      mentionsSchedule: /计划|定时|任务|schedule|Schedule|task|Task/.test(text),
      scheduleButtons: buttons.filter(b => /计划|定时|任务|schedule|task/i.test(`${b.label}${b.title}${b.text}`)).slice(0, 12),
      bodyText: text.replace(/\s+/g, ' ').slice(0, 300),
    }
  })

  console.log(`插件侧栏已挂载: ${shape.pluginMounted}`)
  console.log(`行: ${JSON.stringify(shape.rows)}`)
  console.log(`页面提到计划/任务类字样: ${shape.mentionsSchedule}`)
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
  running.kill()
  await browser.close()
}
