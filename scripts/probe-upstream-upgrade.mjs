/**
 * Does this plugin still load on the installed DSH after an upstream upgrade?
 *
 * The vendored copy was taken from 0.1.7-rc.2 and the install is now 0.2.0-rc.1.
 * A vendored client bundle is not version-pinned: it resolves the same externals
 * through the shell's module table, disables the official row by id, and claims the
 * sidebar's single slot. Any of those can break on an upgrade, and the failure modes
 * differ:
 *
 *   - the loader id or an external disappears → the client half never evaluates;
 *   - the disabled row's id changed → two claimants of one slot, a hard startup error;
 *   - an external kept its name but changed shape → the sidebar renders wrongly or
 *     throws on mount.
 *
 * So this reports all three separately rather than a single pass/fail: the server
 * URL, every page error and console error, whether our row mounted (the project
 * affordance only exists in our sidebar), which sidebar is on screen, and whether
 * the official bundle's version matches what `src/vendored/README.md` records.
 *
 * Usage: node probe-upstream-upgrade.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { findInstalledAsar, readAsarFile } from './lib/asar.mjs'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-upstream-upgrade.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17780 : 17781
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

/** The version this plugin's vendored source was copied from. */
const VENDORED_FROM = '0.1.7-rc.2'

// Read the installed versions straight out of the asar, so "which upstream are we
// actually running against" is answered by the artifact and not by a lockfile.
const asar = findInstalledAsar()
const versionOf = (entry) => {
  if (asar === undefined) return null
  try {
    return JSON.parse(readAsarFile(asar, entry)).version
  } catch {
    return null
  }
}
const installedDesktop = versionOf('/package.json')
const installedWorkspace = versionOf('/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/package.json')

console.log(`vendored from           : ${VENDORED_FROM}`)
console.log(`installed dsh-desktop   : ${String(installedDesktop)}`)
console.log(`installed ui-workspace  : ${String(installedWorkspace)}`)
console.log(`upstream matches vendor : ${installedWorkspace === VENDORED_FROM}`)
console.log('')

const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${out.slice(-2000)}`)), 120_000)
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

  const shape = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-row-key]')].map(node => node.getAttribute('data-row-key')),
    // The project affordance exists only in this plugin's sidebar.
    pluginMounted: document.querySelector('button[aria-label="新建项目"]') !== null,
    // The official sidebar's own workspace-add control.
    officialAddWorkspace: document.querySelector('button[aria-label="添加工作区"], button[aria-label*="工作区"]') !== null,
    bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
  }))

  console.log(`HTTP                    : ${url.replace(/\?token=.*/, '')} (reached)`)
  console.log(`插件侧栏已挂载           : ${shape.pluginMounted}`)
  console.log(`行: ${JSON.stringify(shape.rows)}`)
  console.log(`侧栏文字: ${shape.bodyText}`)
  console.log('')
  console.log(`pageerror (${pageErrors.length}):`)
  for (const error of pageErrors) console.log(`  ${error}`)
  console.log(`console error (${consoleErrors.length}):`)
  for (const error of consoleErrors.slice(0, 12)) console.log(`  ${error}`)

  console.log('')
  console.log('=== 判定 ===')
  console.log(`  插件在新版下是否挂载: ${shape.pluginMounted ? '✅ 是' : '❌ 否'}`)
  console.log(`  是否出现启动级错误    : ${pageErrors.length === 0 ? '✅ 无' : `❌ ${pageErrors.length} 个`}`)
  console.log(`  上游版本是否仍匹配 vendor: ${installedWorkspace === VENDORED_FROM ? '✅ 匹配（无需同步）' : `⚠️ 已变（vendor ${VENDORED_FROM} → 安装 ${String(installedWorkspace)}）`}`)
} finally {
  running.kill()
  await browser.close()
}
