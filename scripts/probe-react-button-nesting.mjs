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
 * The four shapes are measured one at a time, with each render's console output bounded by
 * its own snapshot: a single page-lifetime filter cannot say *which* shape warned, so it
 * could not establish the conclusion this file exists for ("button>button warns and
 * div>button does not"). The run exits non-zero when the premise fails — if the
 * `button>button` warning is missing, the probe would otherwise report "no warning" and
 * pass for a reason that has nothing to do with nesting.
 *
 * Usage: node probe-react-button-nesting.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

/** The React major this probe's premise is built on (`validateDOMNesting` in the dev build). */
const EXPECTED_REACT_MAJOR = 18

/**
 * Resolved relative to this script, not to the caller's cwd: `readFileSync('node_modules/...')`
 * only worked when the process happened to be started from the repository root, and a missing
 * file surfaced as a raw ENOENT stack trace instead of a statement about the environment.
 * `DSH_PROBE_REPO_ROOT` can point at another checkout.
 */
const repoRoot = process.env.DSH_PROBE_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const modulePath = (relative) => {
  const file = join(repoRoot, 'node_modules', relative)
  if (!existsSync(file)) {
    throw new Error(`${file} 不存在：先在 ${repoRoot} 安装依赖（pnpm install），或用 DSH_PROBE_REPO_ROOT 指向正确的检出目录`)
  }
  return file
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const reactVersion = JSON.parse(readFileSync(modulePath('react/package.json'), 'utf8')).version
const reactSource = readFileSync(process.env.PROBE_REACT ?? modulePath('react/cjs/react.development.js'), 'utf8')
const reactDomSource = readFileSync(process.env.PROBE_REACT_DOM ?? modulePath('react-dom/cjs/react-dom.development.js'), 'utf8')
// ReactDOM's development build requires `scheduler`; without it the whole tree fails to
// load and the check would report "no warning" for a reason that has nothing to do with
// nesting — a false pass.
const schedulerSource = readFileSync(process.env.PROBE_SCHEDULER ?? modulePath('scheduler/cjs/scheduler.development.js'), 'utf8')

console.log(`react=${reactVersion}  (开发版构建；生产版会剥掉 validateDOMNesting)`)
// Asserted before anything is concluded from the run: drawing nesting conclusions from a
// different major would silently change what is being tested.
check(`安装的 React 是 ${String(EXPECTED_REACT_MAJOR)}.x`, reactVersion.startsWith(`${String(EXPECTED_REACT_MAJOR)}.`), reactVersion)

let browser
let page
const logs = []

try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Registered after `newPage()`, not at module scope: at module scope these ran against an
  // undefined `page` and threw before the browser had launched.
  page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`))
  // A blank document: nothing else can log, so every captured line belongs to React.
  await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')

  // React's development builds are CommonJS and the browser has no loader, so each
  // one is wrapped in a real `<script>` element by `addScriptTag` rather than run
  // through the `Function` constructor.
  //
  // Functionally the two are close — both execute source that came from
  // `node_modules` — but a script tag is how a browser normally evaluates a
  // bundle, and it keeps an eval-shaped construct out of the probes. A reader
  // copying this file as a template copies a loader, not `new Function(...)`.
  //
  // The wrapper supplies the three names a CJS module expects:
  //   - `module` / `exports`, captured back onto `window` after the source runs;
  //   - `require`, closed over the modules already loaded, in dependency order
  //     (`react` → `scheduler` → `react-dom`).
  //
  // `process` is shimmed because the development builds read
  // `process.env.NODE_ENV`; without it the dev build throws on load and the probe
  // would report "no nesting warning" for a reason unrelated to nesting.
  const loadModule = async (name, source, deps) => {
    const depMap = Object.entries(deps)
      .map(([spec, value]) => `${JSON.stringify(spec)}: window[${JSON.stringify(value)}]`)
      .join(', ')
    await page.addScriptTag({
      content: `
        window.process = window.process || { env: { NODE_ENV: 'development' } };
        (function () {
          var module = { exports: {} };
          var exports = module.exports;
          var __deps = { ${depMap} };
          var require = function (spec) {
            if (Object.prototype.hasOwnProperty.call(__deps, spec)) return __deps[spec];
            throw new Error(${JSON.stringify(name)} + ' requires ' + spec);
          };
          ${source}
          window[${JSON.stringify(name)}] = module.exports;
        })();
      `,
    })
  }

  await loadModule('__react', reactSource, {})
  await loadModule('__scheduler', schedulerSource, {})
  await loadModule('__reactDom', reactDomSource, { react: '__react', scheduler: '__scheduler' })

  const result = await page.evaluate(async () => {
    // Console output is captured *here*, so each shape's warnings can be bounded by a snapshot
    // taken immediately around its own render. A page-lifetime listener on the Node side cannot
    // attribute a line to a shape.
    const captured = []
    const originalError = console.error
    console.error = (...args) => {
      captured.push(args.map((value) => String(value)).join(' '))
      originalError.apply(console, args)
    }
    const restore = () => { console.error = originalError }

    let React
    let ReactDOM
    try {
      React = window.__react
      ReactDOM = window.__reactDom
      if (React === undefined || ReactDOM === undefined) throw new Error('a module failed to define its exports')
    } catch (error) {
      restore()
      return { error: error.message }
    }

    const host = document.querySelector('#root')
    // Checked explicitly: `createRoot(null)` throws an opaque error, and this file already
    // reports load failures as data rather than as a crash.
    if (host === null) {
      restore()
      return { error: '#root 不存在（setContent 被改动或与加载竞争）' }
    }
    let root
    try {
      root = ReactDOM.createRoot(host)
    } catch (error) {
      restore()
      return { error: `createRoot 失败: ${error.message}` }
    }

    /**
     * Render one shape and wait for React to commit it.
     *
     * The commit is signalled by a `useEffect` inside the rendered tree (the wrapper component
     * adds no DOM node), with a bounded fallback: a fixed 300 ms sleep made the "no warning"
     * verdict timing-dependent, and a warning logged after the sleep would have read as a pass.
     * A render that throws synchronously is recorded instead of rejecting `page.evaluate`, so
     * render-time failures are reported the way load failures are.
     */
    const render = (element) => new Promise((resolve) => {
      let committed = false
      const Probe = () => {
        React.useEffect(() => { committed = true })
        return element
      }
      let settled = false
      const finish = (timedOut) => { if (!settled) { settled = true; resolve(timedOut) } }
      try {
        root.render(React.createElement(Probe))
      } catch (error) {
        captured.push(`render threw: ${String(error?.message ?? error)}`)
        finish(false)
        return
      }
      const deadline = Date.now() + 2000
      const poll = () => {
        if (committed) return finish(false)
        if (Date.now() > deadline) return finish(true)
        setTimeout(poll, 10)
      }
      poll()
    })

    const shapes = []
    const measure = async (label, element) => {
      const before = captured.length
      const timedOut = await render(element)
      shapes.push({ label, html: host.innerHTML, warnings: captured.slice(before), timedOut })
    }

    // 1. button > button — the structure the user asked about.
    await measure('button>button',
      React.createElement('button', { type: 'button' },
        '指定工作区',
        React.createElement('button', { type: 'button' }, '选择工作区'),
      ))

    // 2. div[role=radio] > button — the alternative container.
    await measure('div[role=radio]>button',
      React.createElement('div', { role: 'radio', tabIndex: 0, 'aria-checked': 'false' },
        '指定工作区',
        React.createElement('button', { type: 'button' }, '选择工作区'),
      ))

    // 3. Sibling buttons under a plain wrapper — the earlier proposal.
    await measure('div>(button,button)',
      React.createElement('div', null,
        React.createElement('button', { type: 'button' }, '指定工作区'),
        React.createElement('button', { type: 'button' }, '选择工作区'),
      ))

    // 4. button > span[role=button][tabindex=0] — keeps the card a real <button>.
    //
    // React's validator matches **tag names**, not ARIA roles, and HTML's content model
    // forbids "interactive content" (a fixed element list that does not include a
    // `span`). So this shape may satisfy both while keeping the card's native button
    // semantics — the smallest change from the official card.
    await measure('button>span[role=button]',
      React.createElement('button', { type: 'button' },
        '指定工作区',
        React.createElement('span', { role: 'button', tabIndex: 0 }, '选择工作区'),
      ))

    try { root.unmount() } catch { /* nothing to clean up if unmount fails */ }
    restore()
    return { shapes }
  })

  const MAX_PRINTED = 60
  console.log('')
  console.log('=== 渲染结果与逐形状的告警 ===')
  const NESTING_PATTERN = /descendant|cannot appear|validateDOMNesting/i
  if (result.error !== undefined) {
    console.log(`  加载 React 失败: ${result.error}`)
  } else {
    for (const shape of result.shapes) {
      const warnings = shape.warnings.filter(line => NESTING_PATTERN.test(line))
      const prefix = warnings.length > 0 ? `✅ ${String(warnings.length)} 条嵌套告警` : '无嵌套告警'
      console.log(`  ${shape.label.padEnd(24)}: ${prefix}${shape.timedOut ? '  (提交等待超时，结论不可信)' : ''}`)
      console.log(`      ${shape.html}`)
      for (const warning of warnings) console.log(`      ↳ ${warning.slice(0, 260)}`)
    }
  }

  console.log('')
  // The verdict is computed from the per-shape windows above, so this printed list is evidence
  // only; the truncation count is surfaced so it cannot silently disagree with the conclusion.
  console.log('=== 页面上的全部 console 输出 ===')
  for (const line of logs.slice(0, MAX_PRINTED)) console.log(`  ${line}`)
  if (logs.length > MAX_PRINTED) console.log(`  …（另有 ${String(logs.length - MAX_PRINTED)} 行未打印；判定不依赖这段列表）`)
  if (logs.length === 0) console.log('  （无任何输出）')

  console.log('')
  console.log('=== 判定 ===')
  if (result.error === undefined) {
    const byLabel = new Map(result.shapes.map(shape => [shape.label, shape]))
    const warns = (label) => (byLabel.get(label)?.warnings ?? []).some(line => NESTING_PATTERN.test(line))
    const nestedWarns = warns('button>button')
    const divWarns = warns('div[role=radio]>button')
    const spanWarns = warns('button>span[role=button]')
    const renderErrors = result.shapes.flatMap(shape => shape.warnings.filter(line => /render threw/i.test(line)))
    const timedOut = result.shapes.filter(shape => shape.timedOut).map(shape => shape.label)

    console.log(`  button>button           告警: ${nestedWarns ? '是' : '否'}`)
    console.log(`  div[role=radio]>button  告警: ${divWarns ? '是' : '否'}`)
    console.log(`  button>span[role=button]告警: ${spanWarns ? '是' : '否'}`)
    console.log(`  ⇒ ${nestedWarns && !divWarns
      ? '"卡片用 div + role=radio"即可让按钮安然待在卡片内部。'
      : '四个形状的告警分布与预期不符，见上面的逐形状结果。'}`)

    // The gate. `button>button` MUST warn: if it does not, either the dev build is not the one
    // under test or `validateDOMNesting` is gone, and every "no warning" line above is vacuous.
    check('前提：React 开发版对 button>button 告警', nestedWarns,
      nestedWarns ? undefined : '没有捕获到告警——本次运行的"无告警"结论因此不成立')
    check('没有形状在渲染时抛错', renderErrors.length === 0, renderErrors.join(' | ') || undefined)
    check('每个形状的提交都在超时内完成', timedOut.length === 0, timedOut.join(', ') || undefined)
  } else {
    check('React 加载成功', false, result.error)
  }
} finally {
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exitCode = failures.length === 0 ? 0 : 1
