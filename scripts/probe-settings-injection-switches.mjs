/**
 * The project-context injection switches on this plugin's settings card.
 *
 * The card lives on the Plugins page, so this drives the real UI there rather
 * than the Remote: what is under test is the pair's presentation and their
 * coupling, neither of which a Remote call would observe.
 *
 *   1. both switches render, with the document one on by default;
 *   2. the document switch is **disabled** while the master is off;
 *   3. turning the master off is persisted (the Host's global says so);
 *   4. the master turning off disables the document control and reports why;
 *   5. turning the master back on re-enables it and restores the stored choice;
 *   6. the document switch writes on its own while the master is on.
 *
 * Usage: node probe-settings-injection-switches.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-settings-injection-switches.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = 17973
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

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
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))

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

/** The stored global, read straight off the Host's durable unit. */
const storedGlobal = () => {
  try {
    return JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')).global
  } catch {
    return undefined
  }
}

/** The switch whose accessible name is `label`. */
const switchFor = (label) => page.getByRole('switch', { name: label }).first()

let running = child
/**
 * A failure raised by the driver itself, as opposed to a check.
 *
 * Kept because the `finally` below exits the process: without capturing it, a
 * throw anywhere in the steps would bypass the summary and be reported as a
 * pass. A probe that can report success after crashing is worse than no probe.
 */
let driverError
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 打开 Plugins 页并进入本插件 ===')
  // The same route `probe-settings-card.mjs` settled on: the sidebar's Plugins
  // button, then the bundle's own row. Wording-based navigation was tried first
  // and did not reach the page — the shell opens this panel by that button.
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  const listText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  console.log(`  Plugins 页文字: ${JSON.stringify(listText.slice(0, 600))}`)
  // The installed bundle's row. Matched by its display name: the page shows the
  // localized title, not the package name, so a `dsh-project-groups` lookup never
  // resolves here.
  await page.getByText('项目分组', { exact: true }).first().click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()

  const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  console.log(`  页面文字片段: ${JSON.stringify(bodyText.slice(0, 500))}`)
  console.log(`  switch 总数: ${await page.getByRole('switch').count()}`)

  const info = switchFor('注入项目信息')
  const doc = switchFor('注入项目文档')
  check('1) 注入项目信息开关存在', await info.count() > 0)
  check('1) 注入项目文档开关存在', await doc.count() > 0)
  check('1) 项目信息默认开', (await info.isChecked()) === true,
    String(await info.isChecked()))
  check('1) 项目文档默认关', (await doc.isChecked()) === false,
    String(await doc.isChecked()))
  check('2) 文档开关当前可用', (await doc.isDisabled()) === false)

  console.log('')
  console.log('=== 3. 关掉 master ⇒ 落盘 + 文档开关变灰 ===')
  await info.click({ force: true })
  await page.waitForTimeout(2000)
  const g = storedGlobal()
  console.log(`  Host global: ${JSON.stringify({ info: g?.injectProjectInfo, doc: g?.injectProjectDoc })}`)
  check('3) Host 记录了 master 关闭', g?.injectProjectInfo === false, String(g?.injectProjectInfo))
  check('3) 开关显示为关', (await info.isChecked()) === false, String(await info.isChecked()))
  check('4) 文档开关被禁用', (await doc.isDisabled()) === true)
  const cardText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check('4) 说明文案指出由 master 控制', cardText.includes('由「注入项目信息」控制，现已关闭'),
    cardText.slice(0, 200))

  console.log('')
  console.log('=== 5. 重开 master ⇒ 文档开关恢复可用，且保留原选择 ===')
  await info.click({ force: true })
  await page.waitForTimeout(2000)
  const g2 = storedGlobal()
  check('5) Host 记录了 master 打开', g2?.injectProjectInfo === true, String(g2?.injectProjectInfo))
  check('5) 文档开关恢复可用', (await doc.isDisabled()) === false)
  check('5) 文档的存储值未被联动改写', g2?.injectProjectDoc === false,
    String(g2?.injectProjectDoc))

  console.log('')
  console.log('=== 6. master 开着时，文档开关独立写入 ===')
  await doc.click({ force: true })
  await page.waitForTimeout(2000)
  const g3 = storedGlobal()
  check('6) Host 记录了文档开启', g3?.injectProjectDoc === true, String(g3?.injectProjectDoc))
  check('6) master 未受影响', g3?.injectProjectInfo === true, String(g3?.injectProjectInfo))
  check('6) 开关显示为开', (await doc.isChecked()) === true)

  // Put it back so a rerun starts from the shipped defaults.
  await doc.click({ force: true })
  await page.waitForTimeout(1500)
} catch (error) {
  driverError = error
} finally {
  console.log('')
  if (driverError !== undefined) {
    // Report the crash, and fail regardless of how many checks had passed: an
    // incomplete run is not a green one.
    console.log(`探针中断: ${driverError instanceof Error ? driverError.stack : String(driverError)}`)
    failures.push('probe aborted')
  }
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
  await browser.close().catch(() => {})
  running.kill()
  process.exit(failures.length === 0 ? 0 : 1)
}
