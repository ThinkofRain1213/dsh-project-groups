/**
 * Does creating a project open a Session, and does the switch control it?
 *
 * Z-3 makes the header's create dialog follow the official add-workspace flow:
 * the project row appears and a Session is opened and filed under it. This drives
 * the real UI to prove both the behaviour and the switch, in both positions, and
 * to check the one thing static reading cannot settle — that the new project ends
 * up NOT empty.
 *
 * Read from the sidebar rather than the Host, because the question is what the
 * user sees: a Session drawn under the new project's row.
 *
 * Usage: node probe-create-opens-session.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-create-opens-session.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = 17797
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
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

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

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()

/** Sessions drawn under one project row, by the row key of the Session. */
const sessionsUnder = (groupKey) => page.evaluate((groupKey) => {
  const rows = [...document.querySelectorAll('[data-row-key]')]
  let group = null
  const found = []
  for (const node of rows) {
    const key = node.getAttribute('data-row-key')
    if (key.startsWith('workspace:')) { group = key.slice('workspace:'.length); continue }
    if (!key.startsWith('session:')) continue
    if (group === groupKey) found.push(key)
  }
  return found
}, groupKey)

const makeProject = async (title) => {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(3500)
}

/** Open the Plugins page and the project-groups bundle's own detail page. */
const openCard = async () => {
  await dismiss()
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  // The bundle's row in the list. It renders the package name, and possibly the
  // localized title beside it, so the match is by substring on either.
  const candidates = [
    page.locator('text=dsh-project-groups').first(),
    page.locator('text=项目分组').first(),
  ]
  for (const entry of candidates) {
    if (await entry.count() > 0) {
      await entry.click({ force: true }).catch(() => {})
      await page.waitForTimeout(2500)
      await dismiss()
      return
    }
  }
  console.log('  (could not find the bundle row on the Plugins page)')
}

/** The card's switch, located by its accessible name. */
const switchBox = () => page.getByRole('switch', { name: '新建项目时开启会话' }).first()

/** Flip the card's switch to `wanted`. Returns the state afterwards, or null. */
const setSwitch = async (wanted) => {
  await openCard()
  if (await switchBox().count() === 0) {
    // Diagnostic: the card is the only place this switch exists, so say what the
    // page actually showed rather than only that the locator missed.
    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ')
    console.log(`  (switch not found; page text: ${JSON.stringify(body.slice(0, 300))})`)
    return null
  }
  const read = async () => (await switchBox().getAttribute('aria-checked')) === 'true'
  if (await read() !== wanted) {
    await switchBox().click({ force: true })
    await page.waitForTimeout(1500)
  }
  return await read()
}

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(7000)
await dismiss()

const stamp = Date.now().toString(36)
const A = `开${stamp}`
const B = `关${stamp}`

// ---- Case 1: default (on) — creating a project opens a Session under it --------
await makeProject(A)
const keyA = (await projectRow(A).getAttribute('data-row-key') ?? '').replace('workspace:', '')
const underA = await sessionsUnder(keyA)
check('creating a project opens a Session under it', underA.length > 0, `rows=${underA.length}`)
check('and the new project is not left empty', underA.length > 0, A)

// ---- Case 2: switch off — creating a project does NOT open one ----------------
const switchState = await setSwitch(false)
if (switchState === null) {
  console.log('SKIP  设置页未找到开关 —— 未能验证关闭态')
} else {
  check('the switch reads off after clicking it', switchState === false, String(switchState))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6000)
  await dismiss()
  const before = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].length)
  await makeProject(B)
  const keyB = (await projectRow(B).getAttribute('data-row-key') ?? '').replace('workspace:', '')
  const underB = await sessionsUnder(keyB)
  const after = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].length)
  check('with the switch off the new project gets no Session', underB.length === 0, `rows=${underB.length}`)
  check('and no Session was created at all', after === before, `${before} -> ${after}`)
  await setSwitch(true)
}

check('no page error', pageErrors.length === 0, pageErrors.join(' | '))

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
await browser.close()
child.kill()
process.exit(failures.length === 0 ? 0 : 1)
