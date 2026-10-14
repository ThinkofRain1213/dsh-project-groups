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
 * the official bundle's version still matches the one `src/vendored/README.md`
 * records — that baseline is read out of the README, not repeated here.
 *
 * Usage: node probe-upstream-upgrade.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { findInstalledAsar, readAsarFile } from './lib/asar.mjs'
import { redactToken } from './lib/redact.mjs'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-upstream-upgrade.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// `join` + an overridable port: the escaped-backslash path cannot resolve off Windows, and a
// profile other than `pg` used to collapse silently onto the second port (colliding with a
// parallel probe or a stale server).
const PROFILE_PORTS = { pg: 17780, official: 17781 }
const PORT = Number(process.env.DSH_PROBE_PORT ?? PROFILE_PORTS[profile])
if (!Number.isInteger(PORT)) {
  console.error(`unknown profile '${profile}'; supported: ${Object.keys(PROFILE_PORTS).join(', ')}`)
  process.exit(2)
}
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const repoRoot = process.env.DSH_PROBE_REPO_ROOT ?? process.cwd()

/**
 * The version this plugin's vendored source was copied from, read out of the vendored
 * README's own table.
 *
 * Read rather than hardcoded: the header below promises a comparison against what
 * `src/vendored/README.md` records, and a second copy of the number here could only drift
 * from it. The fallback keeps the probe running (and says why) if the table changes shape —
 * an unreadable baseline then shows up as a mismatch rather than as a silent pass.
 */
const VENDORED_FROM = (() => {
  try {
    const readme = readFileSync(join(repoRoot, 'src', 'vendored', 'README.md'), 'utf8')
    return /^\|\s*Version\s*\|\s*\*\*([^*]+)\*\*/m.exec(readme)?.[1] ?? 'unknown(README 里没有 Version 行)'
  } catch (error) {
    return `unknown(读不到 src/vendored/README.md: ${String(error?.message ?? error)})`
  }
})()

/**
 * The onboarding mask's dismissal labels, in the order to try them.
 *
 * Centralized because they are localized copy: when a wording changes upstream, this is the
 * one obvious line to update, and the failure it causes (the mask never goes away) is
 * reported by {@link dismiss} rather than silently changing what the probe reads.
 */
const DISMISS_LABELS = ['稍后配置', '继续', 'Later']

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

// Everything from the spawn onward lives inside the `try` below, so that *every*
// failure path reaches the `finally` that kills the child and closes the browser.
//
// The earlier shape spawned and launched before the `try`, which meant a boot
// timeout (120 s — reached exactly when `exe`/`BIN` is wrong, or the process dies
// before printing `dsh web:`) rejected outside it and left the spawned Host running
// as an orphan. The port is fixed (`PORT` above), so the orphan then held it and
// poisoned the next run — the recurring "port already in use" failures across these
// probes.
//
// `running`/`browser` are `let` and start undefined because the `finally` has to
// tolerate a throw before either exists (a spawn that fails synchronously, a launch
// that never returns). The review suggested `const` for `running` on the grounds that
// nothing reassigns it; that was true of the old shape, where it was initialised from
// `child` before the `try`, and stops being true once the assignment moves inside.
let running
let browser
try {
  running = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Backstop for a failure that bypasses the `finally` (an uncaught throw in a
  // signal handler, or a killed process): registered once the child exists.
  process.on('exit', () => {
    if (running !== undefined && running.exitCode === null && running.signalCode === null) running.kill()
  })
  let out = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-2000))}`)), 120_000)
    // A spawn that never produced a process (bad path, permission denied) or one that died at
    // once rejects here instead of waiting out the full 120 s and then reporting a bare "boot
    // timeout" with no cause. `running` is the handle — this used to read `child`, a name that
    // does not exist in this file, so the executor threw a ReferenceError and the boot promise
    // rejected with that instead of with anything about the spawn.
    running.on('error', (error) => { clearTimeout(timer); reject(error) })
    running.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`Host exited before printing its URL (code ${String(code)}, signal ${String(signal)}):\n${redactToken(out.slice(-2000))}`))
    })
    running.stdout.on('data', (chunk) => {
      out += String(chunk)
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
    })
    running.stderr.on('data', (chunk) => { out += chunk })
  })

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
    .some(node => node.className.includes('mask')))
  /**
   * Dismiss the onboarding mask, if it is up.
   *
   * Bounded and diagnostic. The previous shape re-clicked all three labels with `force` every
   * round and discarded every error, so "the mask was already gone" and "the button is
   * unclickable" were indistinguishable, and a run that never dismissed the mask spent ~35 s
   * before continuing to read a screen it did not intend. Each round now stops as soon as the
   * mask clears, click failures are logged, and a mask that outlives the budget is reported.
   * @returns true when no mask is on screen at the end.
   */
  const dismiss = async () => {
    for (let i = 0; i < 8; i += 1) {
      if (!await isMasked()) return true
      for (const label of DISMISS_LABELS) {
        const button = page.getByRole('button', { name: label, exact: true }).first()
        if (await button.count() === 0) continue
        await button.click({ force: true }).catch((error) => {
          console.log(`  遮罩点击「${label}」失败: ${String(error?.message ?? error).split('\n')[0]}`)
        })
        await page.waitForTimeout(1200)
        if (!await isMasked()) return true
      }
      await page.waitForTimeout(700)
    }
    console.log('  ⚠️ 遮罩 8 轮后仍在：下面的读数可能取自错误的界面')
    return false
  }

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(9000)
  await dismiss()

  const shape = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-row-key]')].map(node => node.getAttribute('data-row-key')),
    // Structural markers rather than copy: `data-row-key` is the sidebar's own row identity, and
    // the two affordances are matched by their accessible names — which is as close to a stable
    // hook as an installed bundle offers. A wording change upstream makes both read `false`,
    // which is exactly the signal this probe is supposed to give.
    // The project affordance exists only in this plugin's sidebar.
    pluginMounted: document.querySelector('button[aria-label="新建项目"]') !== null,
    // The official sidebar's own workspace-add control.
    officialAddWorkspace: document.querySelector('button[aria-label="添加工作区"], button[aria-label*="工作区"]') !== null,
    bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
  }))

  console.log(`HTTP                    : ${url.replace(/\?token=.*/, '')} (reached)`)
  console.log(`插件侧栏已挂载           : ${shape.pluginMounted}`)
  console.log(`官方「添加工作区」在屏   : ${shape.officialAddWorkspace}`)
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
  console.log(`  官方侧栏是否仍在屏上  : ${shape.officialAddWorkspace ? '是（官方那一半还在）' : '否（只剩插件侧栏）'}`)
  console.log(`  是否出现启动级错误    : ${pageErrors.length === 0 ? '✅ 无' : `❌ ${pageErrors.length} 个`}`)
  console.log(`  上游版本是否仍匹配 vendor: ${installedWorkspace === VENDORED_FROM ? '✅ 匹配（无需同步）' : `⚠️ 已变（vendor ${VENDORED_FROM} → 安装 ${String(installedWorkspace)}）`}`)
} finally {
  running?.kill()
  await browser?.close()
}
