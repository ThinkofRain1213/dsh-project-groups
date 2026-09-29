/**
 * Can a "choose workspace" button sit inside the card without triggering the card?
 *
 * The previous probe answered a different question than the one asked: it nested the
 * inner button and measured the *default* click path, which bubbles — but it never
 * applied `stopPropagation`, so it demonstrated the problem rather than testing the
 * proposed fix. This measures the fix, and the container choices that decide whether
 * the fix is even needed.
 *
 * Four structures, each clicked twice (inner button, then the card's own area):
 *
 *   A. card = <button>, inner = <button>, inner stops propagation
 *   B. card = <button>, inner = <button>, no stopPropagation      (control)
 *   C. card = <div role="radio" tabindex=0>, inner = <button>, inner stops
 *   D. card = <div role="radio" tabindex=0>, inner = <button>, no stop       (control)
 *
 * A and C are the implementations under consideration. The difference between them is
 * only the container: a `<button>` may not contain interactive content per the HTML
 * content model, while a `div` may — so C is the variant that keeps the button visually
 * inside the card *and* stays valid.
 *
 * Also measured, because "it clicks" is not the same as "it is usable":
 *   - whether the inner button can take focus (a nested interactive inside a button is
 *     the case where browsers historically kept focus outside);
 *   - whether Enter on the focused card selects the mode;
 *   - whether the inner button is reachable by Tab from the card.
 *
 * Usage: node probe-card-nesting-options.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-card-nesting-options.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17870 : 17871
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
const consoleMessages = []
page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`))
page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`))

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6000)

  const result = await page.evaluate(() => {
    const sandbox = document.createElement('div')
    sandbox.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.append(sandbox)

    /**
     * Build one card structure.
     *
     * The card always looks the same; only its element type and the inner button's
     * propagation handling change. Both handlers record themselves, so "which fired"
     * is read off the log rather than inferred.
     * @param options - container kind and whether the inner click stops propagation.
     * @returns the card and inner button.
     */
    const build = ({ container, stop }) => {
      const card = document.createElement(container)
      if (container === 'button') {
        card.type = 'button'
      } else {
        // A div standing in for the card: the role and tabindex are what make it a
        // control rather than a plain box.
        card.setAttribute('role', 'radio')
        card.setAttribute('aria-checked', 'false')
        card.tabIndex = 0
      }
      card.dataset.events = ''

      const inner = document.createElement('button')
      inner.type = 'button'
      inner.textContent = '选择工作区'

      const record = (who) => {
        card.dataset.events = card.dataset.events === '' ? who : `${card.dataset.events},${who}`
      }
      inner.addEventListener('click', (event) => {
        if (stop) event.stopPropagation()
        record('inner')
      })
      card.addEventListener('click', () => { record('card') })
      // Keyboard activation for the div variant, mirroring what a real implementation
      // would need; on a real <button> the browser does this itself.
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        record('card-key')
      })

      card.append(inner)
      sandbox.append(card)
      return { card, inner }
    }

    const variants = {
      'A button>button + stop': build({ container: 'button', stop: true }),
      'B button>button no stop': build({ container: 'button', stop: false }),
      'C div>button + stop': build({ container: 'div', stop: true }),
      'D div>button no stop': build({ container: 'div', stop: false }),
    }

    const report = {}
    for (const [name, pair] of Object.entries(variants)) {
      // 1. click the inner button
      pair.card.dataset.events = ''
      pair.inner.click()
      const innerClick = pair.card.dataset.events

      // 2. click the card's own area (not the inner button)
      pair.card.dataset.events = ''
      pair.card.click()
      const cardClick = pair.card.dataset.events

      // 3. can the inner button take focus directly?
      pair.inner.focus()
      const innerFocusable = document.activeElement === pair.inner

      // 4. can the card take focus?
      pair.card.focus()
      const cardFocusable = document.activeElement === pair.card

      // 5. is the inner button a tab stop? `tabIndex` is the DOM-level answer; a
      //    negative value or an unset one inside a button would not be reachable.
      const innerTabIndex = pair.inner.tabIndex

      report[name] = {
        innerClick,
        cardClick,
        innerFocusable,
        cardFocusable,
        innerTabIndex,
        innerIsDescendant: pair.card.contains(pair.inner),
        cardTag: pair.card.tagName,
      }
    }

    sandbox.remove()
    return report
  })

  for (const [name, entry] of Object.entries(result)) {
    console.log(`=== ${name} ===`)
    console.log(`  点内部按钮 → 触发: ${JSON.stringify(entry.innerClick)}${entry.innerClick === 'inner' ? '  ✅ 未透到卡片' : entry.innerClick.includes('card') ? '  ❌ 透到卡片' : ''}`)
    console.log(`  点卡片空白处 → 触发: ${JSON.stringify(entry.cardClick)}`)
    console.log(`  内部按钮可聚焦: ${entry.innerFocusable}   卡片可聚焦: ${entry.cardFocusable}   inner.tabIndex=${entry.innerTabIndex}`)
    console.log('')
  }

  console.log('=== 判定 ===')
  const a = result['A button>button + stop']
  const c = result['C div>button + stop']
  console.log(`  stopPropagation 能挡住卡片吗: A=${a.innerClick === 'inner'}  C=${c.innerClick === 'inner'}`)
  console.log(`  ⇒ ${a.innerClick === 'inner' && c.innerClick === 'inner'
    ? '能。事件冒泡是可解的，与容器类型无关。'
    : '不能，需要另找办法。'}`)
  console.log(`  嵌套在 <button> 内的按钮是否可聚焦: ${a.innerFocusable}`)
  console.log(`  嵌套在 <div role=radio> 内的按钮是否可聚焦: ${c.innerFocusable}`)

  console.log('')
  console.log(`=== 页面 console（React 是否就嵌套结构告警）===`)
  const nesting = consoleMessages.filter(message => /nested|validateDOMNesting|button/i.test(message))
  console.log(`  含 nested/button 的消息: ${nesting.length}`)
  for (const message of nesting.slice(0, 8)) console.log(`    ${message}`)
} finally {
  running.kill()
  await browser.close()
}
