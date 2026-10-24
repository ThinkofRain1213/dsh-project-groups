/**
 * Can a "choose workspace" button live *inside* a card that is itself a button?
 *
 * The user wants the workspace chooser in the blue-box position inside the 指定 card,
 * matching the official 外观 row. That row's card is `<button type="button" …>` — and
 * HTML forbids an interactive descendant inside a button, so nesting a second button
 * would be invalid markup whose click handling is browser-dependent.
 *
 * That is a claim about rendering behaviour, so it is measured: a card shaped like the
 * official one is built both ways (nested button vs sibling button), then the resulting
 * DOM and the click behaviour are read back.
 *
 * The clicks are **real pointer clicks at the element's box**, not `element.click()`.
 * A synthetic dispatch skips hit-testing and layout entirely, so it would have shown
 * bubbling even if a real click at those coordinates never reached the inner button —
 * i.e. the measurement would have been a property of the dispatch rather than of the
 * document. The element is located by `data-choose` inside the sandbox, whose own
 * placement is irrelevant because the assertion is about the event chain.
 *
 * Usage: node probe-nested-card-button.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-nested-card-button.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// `join` rather than a hand-written `\\` path: the literal only worked on Windows and
// would have broken silently (a bad BIN surfaces as a boot timeout, not as a path error).
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17860 : 17861))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
// 进程存活但从不监听端口 —— 那时下面这行 spawn 等到的只是一条误导性的超时。
const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile })
if (prepared.problem !== undefined) {
  console.error(`无法准备探针环境：${prepared.problem}`)
  process.exit(2)
}
const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
// The boot await sits outside the try/finally that kills this child, so a rejected boot or a
// failed launch would orphan it (and leave the port bound). This handler closes that window
// without letting the rejection itself go unhandled.
const killChild = () => { try { child.kill() } catch { /* already gone */ } }
const bootUrl = async () => {
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
      // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
      // stdout, so without this handler the promise stayed pending until the 120 s timeout and
      // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
      // the process outright.
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`spawn failed for ${exe}: ${error.message}`))
      })
      // An early exit (bad args, port already in use, a crash) also never prints the URL. Without
      // this the run blocked for the full two minutes and then blamed a timeout; the exit code and
      // the tail of the output are what actually explain it.
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
  } catch (error) {
    killChild()
    throw error
  }
}

let browser
let page

// The spawn above is deliberately outside the try (its `url` await is what the finally must
// cover); the boot wait and launch are inside, so a rejected boot or a failed launch can no
// longer leak the child and its port.
try {
  const url = await bootUrl()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(6000)

  // A detached sandbox so nothing touches the running app's own UI.
  const shapes = await page.evaluate(() => {
    const sandbox = document.createElement('div')
    sandbox.id = 'probe-sandbox'
    // In-viewport and above the app: these are real pointer clicks now, and Playwright
    // refuses to click an element it cannot reach (an off-screen or covered element
    // times out). The box is small and in the corner so nothing of the app is obscured
    // for long, and it is removed again below.
    sandbox.style.position = 'fixed'
    sandbox.style.inset = 'auto auto 0 0'
    sandbox.style.zIndex = '2147483647'
    document.body.append(sandbox)

    const events = []
    window.__probeEvents = events

    /**
     * Build one card. `nested: true` puts the choose button inside the mode button.
     * @returns the mode and choose buttons.
     */
    const buildCard = (nested) => {
      const mode = document.createElement('button')
      mode.type = 'button'
      mode.textContent = '指定工作区'
      mode.addEventListener('click', () => events.push(`${String(nested)}:mode`))

      const choose = document.createElement('button')
      choose.type = 'button'
      choose.textContent = '选择工作区'
      // Addressable for a real click even when nested inside another button.
      choose.setAttribute('data-choose', String(nested))
      choose.addEventListener('click', () => events.push(`${String(nested)}:choose`))

      if (nested) {
        mode.append(choose)
      } else {
        // Sibling inside a shared non-interactive wrapper: valid markup, same visual slot.
        const card = document.createElement('div')
        card.append(mode, choose)
        sandbox.append(card)
        return { mode, choose }
      }
      sandbox.append(mode)
      return { mode, choose }
    }

    const nested = buildCard(true)
    const sibling = buildCard(false)

    // Measure the DOM as the browser actually holds it.
    const describe = (pair) => ({
      // A nested interactive descendant is what the HTML content model forbids.
      containsButton: pair.mode.querySelector('button') !== null,
      // `mode.contains(choose)` is true for the nested case only.
      chooseIsDescendant: pair.mode.contains(pair.choose),
      modeTag: pair.mode.tagName,
    })

    return { nestedShape: describe(nested), siblingShape: describe(sibling) }
  })

  /** Click the choose control with a real pointer and return what fired. */
  const clickAndRecord = async (label) => {
    await page.evaluate(() => { window.__probeEvents.length = 0 })
    await page.locator(`[data-choose="${label}"]`).click()
    return page.evaluate(() => [...window.__probeEvents])
  }

  const nestedEvents = await clickAndRecord('true')
  const siblingEvents = await clickAndRecord('false')

  await page.evaluate(() => { document.querySelector('#probe-sandbox')?.remove() })

  console.log('=== 嵌套（选择按钮放在卡片按钮内部）===')
  console.log(`  卡片标签: ${shapes.nestedShape.modeTag}`)
  console.log(`  卡片内是否含 button: ${String(shapes.nestedShape.containsButton)}`)
  console.log(`  选择按钮是卡片的后代: ${String(shapes.nestedShape.chooseIsDescendant)}`)
  console.log(`  真实点击"选择工作区"触发: ${JSON.stringify(nestedEvents)}`)
  console.log('')
  console.log('=== 兄弟（卡片外观由外层 div 承载，两个按钮并列）===')
  console.log(`  卡片标签: ${shapes.siblingShape.modeTag}`)
  console.log(`  卡片内是否含 button: ${String(shapes.siblingShape.containsButton)}`)
  console.log(`  选择按钮是卡片的后代: ${String(shapes.siblingShape.chooseIsDescendant)}`)
  console.log(`  真实点击"选择工作区"触发: ${JSON.stringify(siblingEvents)}`)
  console.log('')
  console.log('=== 判定 ===')
  // Asserted now, not merely printed: the two conclusions this probe exists to
  // establish are that nesting bubbles into the outer handler and that the sibling
  // shape does not — and a printed line cannot fail.
  check('a nested choose button is an interactive descendant of the card button',
    shapes.nestedShape.containsButton && shapes.nestedShape.chooseIsDescendant,
    JSON.stringify(shapes.nestedShape))
  check('a real click on the nested choose button also triggers the card handler',
    nestedEvents.length === 2 && nestedEvents.includes('true:choose') && nestedEvents.includes('true:mode'),
    JSON.stringify(nestedEvents))
  check('the sibling choose button is not a descendant of the card button',
    !shapes.siblingShape.containsButton && !shapes.siblingShape.chooseIsDescendant,
    JSON.stringify(shapes.siblingShape))
  check('and a real click on it selects without switching the mode',
    siblingEvents.length === 1 && siblingEvents[0] === 'false:choose',
    JSON.stringify(siblingEvents))
  console.log('  ⇒ 嵌套是无效 HTML（button 不得含交互后代），且真实点击会冒泡进外层模式切换；')
  console.log('     兄弟结构有效，且"选择工作区"只做选择、不会顺手改模式。')
} finally {
  child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
