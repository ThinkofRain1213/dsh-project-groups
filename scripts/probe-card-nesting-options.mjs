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
 *   - whether the inner button can take focus programmatically;
 *   - whether the inner button is reachable from the card by a real Tab press (the
 *     `tabindex` attribute and `focus()` alone cannot answer this: `tabIndex` is `0`
 *     for every `<button>` regardless of nesting, and `focus()` only proves
 *     programmatic focusability);
 *   - whether Enter on the focused card reaches a handler. Synthetic KeyboardEvents do
 *     not run a real `<button>`'s activation behaviour, so this only exercises the
 *     explicit keydown handler the `div` variant needs.
 *
 * Usage: node probe-card-nesting-options.mjs <dshExe> <asarRoot> <dshHome> [profile]
 *        DSH_PROBE_PORT overrides the port (two concurrent probes would otherwise
 *        collide on the fixed default and one would attach to the other's server).
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-card-nesting-options.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// `join`, not a literal: the previous escaped-backslash path cannot resolve off
// Windows, where the backslashes are ordinary filename characters and the spawn
// fails with an ENOENT that only surfaced as a 120 s boot timeout.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17870 : 17871))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

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
// Created (not awaited) here, awaited inside the `try` below: awaiting it at the top
// level meant a boot rejection escaped before cleanup, orphaning the host process
// with the port still bound.
const boot = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
  // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
  // stdout, so without this handler the promise stayed pending until the 120 s timeout and
  // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
  // the process outright.
  child.on('error', (error) => {
    clearTimeout(timer)
    reject(new Error(`spawn failed for ${exe}: ${error.message}`))
  })
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
})

/** The verdict suffix for one `dataset.events` string, kept out of the template literal. */
const innerClickNote = (events) => {
  if (events === 'inner') return '  ✅ 未透到卡片'
  if (events.includes('card')) return '  ❌ 透到卡片'
  return ''
}

let browser
try {
  const url = await boot
  browser = await chromium.launch({ headless: true })
  // Inside the `try`: `page.on(...)` used to run before `newPage()`, so the listeners
  // were attached to `undefined` and the probe crashed before it measured anything.
  const page = await browser.newPage()
  const consoleMessages = []
  page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(6000)

  const { report, names } = await page.evaluate(() => {
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
    for (const [index, [name, pair]] of Object.entries(variants).entries()) {
      // The Tab pass below re-finds each card by id after focus moved between evaluates.
      pair.card.id = `probe-card-${index}`

      // 1. click the inner button
      pair.card.dataset.events = ''
      pair.inner.click()
      const innerClick = pair.card.dataset.events

      // 2. click the card's own area (not the inner button)
      pair.card.dataset.events = ''
      pair.card.click()
      const cardClick = pair.card.dataset.events

      // 3. Enter on the focused card. Dispatched for real, since the handler used to be
      //    dead code: nothing ever sent a keydown, so its result was never observed.
      pair.card.dataset.events = ''
      pair.card.focus()
      pair.card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      const cardKey = pair.card.dataset.events

      // 4. can the inner button take focus directly? (programmatic only — see the Tab pass)
      pair.inner.focus()
      const innerFocusable = document.activeElement === pair.inner

      // 5. can the card take focus?
      pair.card.focus()
      const cardFocusable = document.activeElement === pair.card

      report[name] = {
        innerClick,
        cardClick,
        cardKey,
        innerFocusable,
        cardFocusable,
        innerTabAttr: pair.inner.getAttribute('tabindex'),
        innerIsDescendant: pair.card.contains(pair.inner),
        cardTag: pair.card.tagName,
      }
    }

    // The sandbox stays mounted: the Tab pass needs the same live DOM, and a fresh
    // element in every pass would not tell us anything about these structures.
    window.__cardNestingSandbox = sandbox
    return { report, names: Object.keys(variants) }
  })

  // Real sequential navigation. A synthetic `.focus()` and the `tabIndex` property both
  // answer "is this focusable", never "is this *tab-reachable from the card*", which is
  // the claim the header makes about a nested interactive inside a <button>.
  const tabReach = {}
  for (const [index, name] of names.entries()) {
    const id = `probe-card-${index}`
    await page.evaluate((cardId) => { document.getElementById(cardId)?.focus() }, id)
    await page.keyboard.press('Tab')
    tabReach[name] = await page.evaluate((cardId) => {
      const card = document.getElementById(cardId)
      const active = document.activeElement
      return {
        activeTag: active === null ? null : active.tagName,
        reachable: card !== null && active !== null && active !== card && card.contains(active),
      }
    }, id)
  }
  await page.evaluate(() => { window.__cardNestingSandbox?.remove() })

  for (const [name, entry] of Object.entries(report)) {
    const tab = tabReach[name] ?? { reachable: undefined, activeTag: undefined }
    console.log(`=== ${name} ===`)
    console.log(`  点内部按钮 → 触发: ${JSON.stringify(entry.innerClick)}${innerClickNote(entry.innerClick)}`)
    console.log(`  点卡片空白处 → 触发: ${JSON.stringify(entry.cardClick)}`)
    console.log(`  卡片上按 Enter → 触发: ${JSON.stringify(entry.cardKey)}${entry.cardKey === '' ? '（合成事件不触发真实激活）' : ''}`)
    console.log(`  内部按钮可聚焦: ${entry.innerFocusable}   卡片可聚焦: ${entry.cardFocusable}`)
    console.log(`  内部按钮 tabindex 属性: ${entry.innerTabAttr ?? '(未设置)'}   从卡片按 Tab 可到达内部按钮: ${tab.reachable === true ? '是' : `否（焦点落在 ${tab.activeTag ?? '未知'}）`}`)
    console.log(`  结构: card=<${entry.cardTag.toLowerCase()}> 含内部按钮=${entry.innerIsDescendant}`)
    console.log('')
  }

  console.log('=== 判定 ===')
  const a = report['A button>button + stop']
  const c = report['C div>button + stop']
  console.log(`  stopPropagation 能挡住卡片吗: A=${a.innerClick === 'inner'}  C=${c.innerClick === 'inner'}`)
  const stopWorks = a.innerClick === 'inner' && c.innerClick === 'inner'
  console.log(`  ⇒ ${stopWorks ? '能。事件冒泡是可解的，与容器类型无关。' : '不能，需要另找办法。'}`)
  console.log(`  嵌套在 <button> 内的按钮是否可聚焦: ${a.innerFocusable}`)
  console.log(`  嵌套在 <div role=radio> 内的按钮是否可聚焦: ${c.innerFocusable}`)
  console.log(`  嵌套在 <button> 内的按钮是否可从卡片按 Tab 到达: ${tabReach['A button>button + stop']?.reachable === true}`)
  console.log(`  嵌套在 <div role=radio> 内的按钮是否可从卡片按 Tab 到达: ${tabReach['C div>button + stop']?.reachable === true}`)

  console.log('')
  console.log(`=== 页面 console（React 是否就嵌套结构告警）===`)
  // Narrowed to the validator's own wording: a filter that also matched the bare word
  // "button" counted every unrelated log line that mentioned a button.
  const nesting = consoleMessages.filter(message => /validateDOMNesting|<button> cannot appear/i.test(message))
  console.log(`  含 React 嵌套告警的消息: ${nesting.length}`)
  for (const message of nesting.slice(0, 8)) console.log(`    ${message}`)
} finally {
  child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
