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
 * Usage: node probe-nested-card-button.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: probe-nested-card-button.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17860 : 17861
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
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6000)

  // A detached sandbox so nothing touches the running app's own UI.
  const result = await page.evaluate(() => {
    const sandbox = document.createElement('div')
    sandbox.id = 'probe-sandbox'
    sandbox.style.position = 'fixed'
    sandbox.style.inset = 'auto auto 0 0'
    sandbox.style.zIndex = '1'
    document.body.append(sandbox)

    const events = []

    /**
     * Build one card. `nested: true` puts the choose button inside the mode button.
     * @returns the mode button element.
     */
    const buildCard = (nested) => {
      const mode = document.createElement('button')
      mode.type = 'button'
      mode.textContent = '指定工作区'
      mode.addEventListener('click', () => events.push(`${String(nested)}:mode`))

      const choose = document.createElement('button')
      choose.type = 'button'
      choose.textContent = '选择工作区'
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

    const nestedShape = describe(nested)
    const siblingShape = describe(sibling)

    // Click the choose control in each case and see which handlers fire. A nested
    // button bubbles into the outer one, so the outer mode handler runs too — which is
    // either a feature or a surprise, but never nothing.
    const clickAndRecord = (pair, label) => {
      events.length = 0
      pair.choose.click()
      return { label, events: [...events] }
    }

    const nestedClick = clickAndRecord(nested, 'nested')
    const siblingClick = clickAndRecord(sibling, 'sibling')

    sandbox.remove()
    return { nestedShape, siblingShape, nestedClick, siblingClick }
  })

  console.log('=== 嵌套（选择按钮放在卡片按钮内部）===')
  console.log(`  卡片内是否含 button: ${String(result.nestedShape.containsButton)}`)
  console.log(`  选择按钮是卡片的后代: ${String(result.nestedShape.chooseIsDescendant)}`)
  console.log(`  点击"选择工作区"触发: ${JSON.stringify(result.nestedClick.events)}`)
  console.log('')
  console.log('=== 兄弟（卡片外观由外层 div 承载，两个按钮并列）===')
  console.log(`  卡片内是否含 button: ${String(result.siblingShape.containsButton)}`)
  console.log(`  选择按钮是卡片的后代: ${String(result.siblingShape.chooseIsDescendant)}`)
  console.log(`  点击"选择工作区"触发: ${JSON.stringify(result.siblingClick.events)}`)
  console.log('')
  console.log('=== 判定 ===')
  const nestedBubbles = result.nestedClick.events.length > 1
  console.log(`  嵌套时点击会【同时触发外层模式切换】: ${nestedBubbles ? '✅ 是（事件冒泡）' : '否'}`)
  console.log(`  ⇒ 嵌套是无效 HTML（button 不得含交互后代），且行为依赖冒泡；`)
  console.log(`     兄弟结构有效，且"选择工作区"只做选择、不会顺手改模式。`)
} finally {
  running.kill()
  await browser.close()
}
