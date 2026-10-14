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
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-create-opens-session.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a leftover Host from an aborted run holds the fixed port, and the next probe
// then reports a boot timeout for what is really an occupied port.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17797)
// `join`, not a `\\`-joined literal: on a POSIX runner a backslash is an ordinary filename
// character, so the literal path silently never resolves.
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

let child
let browser
let page
const pageErrors = []

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 8; i += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Later']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        // Logged rather than discarded: a click that never landed leaves the mask up, and the
        // checks below then measure an intercepted UI for a setup reason with nothing to say so.
        await button.click({ force: true }).catch((error) => {
          console.log(`  dismiss: click on "${label}" failed — ${error.message}`)
        })
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(700)
  }
  if (await isMasked()) console.log('  dismiss: a modal mask is STILL up after 8 rounds — later checks may be measuring an intercepted UI')
}

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()

/** Whether a project row with this group key is currently rendered. */
const hasGroup = (groupKey) => page.evaluate((groupKey) => [...document.querySelectorAll('[data-row-key^="workspace:"]')]
  .some(node => node.getAttribute('data-row-key') === `workspace:${groupKey}`), groupKey)

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
      // Logged rather than discarded: a click that never landed leaves the detail page closed,
      // and `setSwitch` then reports "switch not found" for what was really a failed click.
      await entry.click({ force: true }).catch((error) => {
        console.log(`  openCard: click failed — ${error.message}`)
      })
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

try {
  // Spawned inside the `try` so the `finally` always closes the browser and kills the child.
  // While this sat above the `try`, any throw (a boot timeout, a locator timeout) skipped both
  // cleanups and left the headless Chromium and the Host running.
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
    // An early exit (bad args, the port already bound, a crash) also never prints a URL, and used
    // to burn the full two minutes before reporting a misleading timeout.
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`dsh exited before printing a URL (code=${String(code)}, signal=${String(signal)}):\n${redactToken(out.slice(-1500))}`))
    })
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
  })

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  const stamp = Date.now().toString(36)
  const A = `开${stamp}`
  const B = `关${stamp}`

  // ---- Case 1: default (on) — creating a project opens a Session under it --------
  await makeProject(A)
  const keyA = (await projectRow(A).getAttribute('data-row-key') ?? '').replace('workspace:', '')
  // The premise is asserted, not assumed: `sessionsUnder('')` would match the **Ungrouped**
  // section (`group === ''`), so an unrendered row read as "no Session under it" — or as the
  // ungrouped rows — and the check below would pass or fail for the wrong reason.
  check('前提：A 的项目行已渲染', keyA !== '' && await hasGroup(keyA), JSON.stringify(keyA))
  const underA = await sessionsUnder(keyA)
  check('creating a project opens a Session under it', underA.length > 0, `rows=${underA.length}`)
  // Distinct from the check above, and it guards the key shape this probe parses: a row that
  // survived the walk must be a real `session:<id>` key, not a stray node.
  check('and the row is a well-formed Session key',
    underA.every(key => /^session:.+/.test(key)), JSON.stringify(underA))

  // ---- Case 2: switch off — creating a project does NOT open one ----------------
  const switchState = await setSwitch(false)
  if (switchState === null) {
    // A skip, but recorded: the switch is the only way to reach the "off" behaviour, so a run
    // that never found it has not verified half of this probe and must not exit zero.
    console.log('SKIP  设置页未找到开关 —— 未能验证关闭态')
    failures.push('the create-opens-session switch was not found, so the off case was not verified')
  } else {
    check('the switch reads off after clicking it', switchState === false, String(switchState))
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForTimeout(6000)
    await dismiss()
    const before = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].length)
    await makeProject(B)
    const keyB = (await projectRow(B).getAttribute('data-row-key') ?? '').replace('workspace:', '')
    check('前提：B 的项目行已渲染', keyB !== '' && await hasGroup(keyB), JSON.stringify(keyB))
    const underB = await sessionsUnder(keyB)
    const after = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].length)
    check('with the switch off the new project gets no Session', underB.length === 0, `rows=${underB.length}`)
    check('and no Session was created at all', after === before, `${before} -> ${after}`)
    await setSwitch(true)
  }

  check('no page error', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
  if (child !== undefined) child.kill() // guarded: a synchronous `spawn` throw leaves it unset
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
