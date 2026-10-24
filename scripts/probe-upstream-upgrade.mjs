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
import { dismissModals as dismissShared, ensureProbeProfile } from './lib/boot-dsh.mjs'
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
 * 关掉挡路的弹窗，并把「最后到底还有没有遮罩」原样返回。
 *
 * 该本地实现保留了自己的返回值语义（`true` = 遮罩已清），所以不复用共享封装：
 * 共享版本返回的是对象，改签名会让下面那条 `⚠️` 判断悄悄变成永远为真。
 * 关不掉的**根因**已经收敛到 `lib/boot-dsh.mjs`：那里的标签表含「关闭」，
 * 而原先本地那份只覆盖旧的一次性公告。
 */const DISMISS_LABELS = ['稍后配置', '继续', 'Later']

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
  // 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
  // 进程存活但从不监听端口 —— 那时下面这行 spawn 等到的只是一条误导性的超时。
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile })
  if (prepared.problem !== undefined) {
    console.error(`无法准备探针环境：${prepared.problem}`)
    process.exit(2)
  }
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
   * 关掉挡路的弹窗，并把「最后到底还有没有遮罩」原样返回。
   *
   * 该本地实现保留了自己的返回值语义（`true` = 遮罩已清），所以不复用共享封装：
   * 共享版本返回的是对象，改签名会让下面那条 `⚠️` 判断悄悄变成永远为真。
   * 关不掉的**根因**已经收敛到 `lib/boot-dsh.mjs`：那里的标签表含「关闭」，
   * 关不掉的**根因**已经收敛到 `lib/boot-dsh.mjs`：那里的标签表含「关闭」，
   * 而原先这里的 `DISMISS_LABELS` 只覆盖旧的一次性公告。
   */
  const dismiss = () => dismissShared(page).then(result => !result.masked)

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
