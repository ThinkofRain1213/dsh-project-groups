/**
 * Does React 18 warn about a `<button>` inside a `<button>`?
 *
 * The user asked whether the choose-workspace button can live *inside* the card. The
 * click path is already measured: `stopPropagation` isolates it. What remains is
 * whether nesting the markup is safe, and there are two candidate reasons it is not:
 *
 *   1. HTML's content model forbids interactive descendants in a `<button>`;
 *   2. React's development build validates nesting and reports a violation through
 *      `console.error`.
 *
 * Reason 2 matters concretely here: several of this plugin's browser probes assert the
 * page produced **no console errors**, so a nesting warning would turn them all red.
 *
 * No DSH server is needed — nesting validation is a property of React, and the plugin
 * pins React 18.3.1. The **development** build is used deliberately: the production
 * build strips `validateDOMNesting`, so testing production would pass vacuously. A
 * blank page also keeps the console capture free of shell noise.
 *
 * Usage: node probe-react-button-nesting.mjs
 */
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const reactSource = readFileSync('node_modules/react/cjs/react.development.js', 'utf8')
const reactDomSource = readFileSync('node_modules/react-dom/cjs/react-dom.development.js', 'utf8')
// ReactDOM's development build requires `scheduler`; without it the whole tree fails to
// load and the check would report "no warning" for a reason that has nothing to do with
// nesting — a false pass.
const schedulerSource = readFileSync(process.env.PROBE_SCHEDULER ?? 'node_modules/scheduler/cjs/scheduler.development.js', 'utf8')

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

const logs = []
page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`))
page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`))

try {
  // A blank document: nothing else can log, so every captured line belongs to React.
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')

  const result = await page.evaluate(async ({ reactSource, reactDomSource, schedulerSource }) => {
    // React's development build reads `process.env.NODE_ENV`; the browser has no
    // `process`, so the shim is what makes the dev build runnable here at all.
    window.process = { env: { NODE_ENV: 'development' } }

    /** Load one CommonJS source into a module object. */
    const loadModule = (source, requireFn) => {
      const module = { exports: {} }
      const factory = new Function('module', 'exports', 'require', source)
      factory(module, module.exports, requireFn)
      return module.exports
    }

    let React
    let ReactDOM
    try {
      // Order matters: ReactDOM resolves both `react` and `scheduler` through the
      // require function handed to it, so both must already be loadable.
      let scheduler
      React = loadModule(reactSource, (spec) => {
        throw new Error(`react requires ${spec}`)
      })
      scheduler = loadModule(schedulerSource, (spec) => {
        throw new Error(`scheduler requires ${spec}`)
      })
      ReactDOM = loadModule(reactDomSource, (spec) => {
        if (spec === 'react') return React
        if (spec === 'scheduler') return scheduler
        throw new Error(`react-dom requires ${spec}`)
      })
    } catch (error) {
      return { error: error.message }
    }

    const host = document.querySelector('#root')
    const root = ReactDOM.createRoot(host)

    /** Render a tree and let React flush. */
    const render = (element) => new Promise((resolve) => {
      root.render(element)
      setTimeout(resolve, 300)
    })

    // 1. button > button — the structure the user asked about.
    await render(
      React.createElement('button', { type: 'button' },
        '指定工作区',
        React.createElement('button', { type: 'button' }, '选择工作区'),
      ),
    )
    const nestedMarkup = host.innerHTML

    // 2. div[role=radio] > button — the alternative container.
    await render(
      React.createElement('div', { role: 'radio', tabIndex: 0, 'aria-checked': 'false' },
        '指定工作区',
        React.createElement('button', { type: 'button' }, '选择工作区'),
      ),
    )
    const cardMarkup = host.innerHTML

    // 3. Sibling buttons under a plain wrapper — the earlier proposal.
    await render(
      React.createElement('div', null,
        React.createElement('button', { type: 'button' }, '指定工作区'),
        React.createElement('button', { type: 'button' }, '选择工作区'),
      ),
    )
    const siblingMarkup = host.innerHTML

    // 4. button > span[role=button][tabindex=0] — keeps the card a real <button>.
    //
    // React's validator matches **tag names**, not ARIA roles, and HTML's content model
    // forbids "interactive content" (a fixed element list that does not include a
    // `span`). So this shape may satisfy both while keeping the card's native button
    // semantics — the smallest change from the official card.
    await render(
      React.createElement('button', { type: 'button' },
        '指定工作区',
        React.createElement('span', { role: 'button', tabIndex: 0 }, '选择工作区'),
      ),
    )
    const spanMarkup = host.innerHTML

    root.unmount()
    return { nestedMarkup, cardMarkup, siblingMarkup, spanMarkup }
  }, { reactSource, reactDomSource, schedulerSource })

  console.log('=== 渲染结果 ===')
  if (result.error !== undefined) {
    console.log(`  加载 React 失败: ${result.error}`)
  } else {
    console.log(`  button>button           : ${result.nestedMarkup}`)
    console.log(`  div[role=radio]>button  : ${result.cardMarkup}`)
    console.log(`  div>(button,button)     : ${result.siblingMarkup}`)
    console.log(`  button>span[role=button]: ${result.spanMarkup}`)
  }

  console.log('')
  console.log('=== 渲染期间的全部日志 ===')
  for (const line of logs.slice(0, 25)) console.log(`  ${line}`)
  if (logs.length === 0) console.log('  （无任何输出）')

  const nestingWarnings = logs.filter(line => /descendant|cannot appear|validateDOMNesting/i.test(line))
  console.log('')
  console.log('=== 判定 ===')
  console.log(`  React 18 开发版对 button>button 告警: ${nestingWarnings.length > 0 ? '✅ 告警' : '否（未捕获到）'}`)
  for (const warning of nestingWarnings) console.log(`    ${warning.slice(0, 260)}`)
  console.log('')
  console.log(`  console error 总数: ${logs.filter(line => line.startsWith('error:') || line.startsWith('pageerror:')).length}`)
  console.log('  ⇒ 若 button>button 告警而 div>button 不告警，')
  console.log('     则"卡片用 div + role=radio"即可让按钮安然待在卡片内部。')
} finally {
  await browser.close()
}
