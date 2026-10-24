/**
 * Two-stage confirmation acceptance: the rebuild asks before it writes.
 *
 * The rebuild creates a directory and registers a Workspace — in `'default'` mode the official
 * default Workspace's own directory — so it now asks first. The confirmation is a **second stage of
 * the same `Modal`**, not a second dialog, which is the property most of these checks exist to pin:
 * nesting two modals would mean two `z-index: 1000` layers, two document-level Escape handlers and
 * two focus traps (measured), so "how many dialogs" is asserted directly rather than assumed.
 *
 * Checks:
 *   1. pressing 重建该工作区 moves to the confirm stage, with **still exactly one** dialog;
 *   2. that stage names the path it is about to touch;
 *   3. keyboard focus is on the confirm action (the Modal only autofocuses on mount, so the switch
 *      has to move focus itself — this is the assertion that fails when it does not);
 *   4. 返回 goes back to the report stage without closing;
 *   5. Escape on the confirm stage goes back, not out;
 *   6. Escape on the report stage still closes (no regression of the earlier behaviour);
 *   7. confirming actually creates and registers;
 *   8. no second dialog ever appears, across the whole sequence.
 *
 * Usage: node probe-base-workspace-confirm.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-confirm.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a leftover Host from an aborted run holds the fixed port, and the next probe
// then reports a boot timeout for what is really an occupied port.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17971 : 17972))
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

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

/**
 * One `/api` RPC, with the response body read and reported.
 *
 * The parse used to be bare `JSON.parse(await response.text())`: a non-JSON body (an HTML error
 * page, an empty 5xx) threw an opaque `SyntaxError` that aborted the probe without naming which
 * RPC had failed. The failure is now a value the caller asserts on, so a broken setup step is
 * reported as itself instead of as a confusing locator failure three steps later.
 */
const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({
      type: 'client-request', rpcId: `p-${Math.random().toString(36).slice(2)}`,
      method, payload: { args },
    }),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      status: response.status, ok: undefined, value: undefined,
      problem: `${method}: non-JSON response (${error.message}): ${text.slice(0, 200)}`,
    }
  }
  return { status: response.status, ok: parsed?.result?.ok, value: parsed?.result?.value, problem: parsed?.result?.error }
}, { method, args })

/**
 * The setting the report is raised against.
 *
 * Reported, not asserted silently: a value with `status !== 200` (or `ok === false`) means the
 * report below is about a stale setting, so the run is stopped rather than measuring the wrong
 * state.
 */
const target = join(dshHome, 'confirm-probe', 'dir')

const storedBase = () => {
  const file = join(dshHome, 'storages', 'project_groups.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')).global?.baseWorkspace ?? null
  } catch (error) {
    // Silent before: a *corrupt* file and an absent setting both read as `null`, so a storage
    // failure surfaced only as a confusing assertion failure with no diagnostic.
    if (existsSync(file)) console.log(`  storedBase: ${file} could not be read/parsed — ${error.message}`)
    return null
  }
}
const registry = () => {
  const file = join(dshHome, 'storages', 'workspace.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Object.entries(parsed.tables?.workspaces ?? {}).map(([id, row]) => ({ id, path: row.path }))
  } catch (error) {
    if (existsSync(file)) console.log(`  registry: ${file} could not be read/parsed — ${error.message}`)
    return []
  }
}

/** Every dialog count this probe samples, so the sweep assertion below is real. */
const observedDialogCounts = []

/** Every visible dialog. More than one at a time is the nesting bug this design avoids. */
const dialogs = () => page.locator('[role="dialog"], [aria-modal="true"]')
/**
 * `dialogs().count()`, recorded into {@link observedDialogCounts}.
 *
 * The final sweep check used to be `check(..., true, ...)` — a literal, so it asserted nothing
 * while the docstring claimed "no second dialog ever appears". Every sample now goes through
 * here, which is what makes that claim measurable.
 */
const dialogCount = async () => {
  const count = await dialogCount()
  observedDialogCounts.push(count)
  return count
}
const dialogText = async () => (await dialogs().first().innerText().catch(() => '')).replace(/\s+/g, ' ')
const newSession = () => page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()

/** Raise the report; returns whether it appeared. */
const raiseReport = async () => {
  await newSession().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  return await dialogCount() > 0
}

try {
  // Spawned inside the `try` so the `finally` always reaches `child.kill()`. While this sat
  // above the `try`, a boot timeout — or any throw out of `chromium.launch` — rejected the
  // top-level await before cleanup ran and left the Host running on the port.
  // 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
  // 进程存活但从不监听端口 —— 那时下面这行 spawn 等到的只是一条误导性的超时。
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile })
  if (prepared.problem !== undefined) {
    console.error(`无法准备探针环境：${prepared.problem}`)
    process.exit(2)
  }
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
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
  })

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(8000)
  await dismiss()

  console.log(`=== 目标路径: ${target}`)
  console.log(`  已存在（应为否）: ${String(existsSync(target))}`)
  // The setup write is asserted, not fire-and-forget: with a rejected write the report below is
  // raised against a stale setting and every later check measures the wrong state.
  const configured = await rpc('projectGroups/setBaseWorkspace', { request: { mode: 'specified', path: target, name: '确认探测' } })
  check('前置：setBaseWorkspace 写入成功', configured.status === 200 && configured.ok !== false,
    `status=${String(configured.status)} ok=${String(configured.ok)} ${JSON.stringify(configured.problem ?? null)}`)
  if (configured.status !== 200 || configured.ok === false) {
    throw new Error('the setBaseWorkspace setup step failed; the report below would be about a stale setting')
  }
  await page.waitForTimeout(1200)

  console.log('')
  console.log('=== 1. 报告阶段 ⇒ 点「重建该工作区」进入确认阶段 ===')
  const raised = await raiseReport()
  check('报告弹窗出现', raised === true)
  const reportText = await dialogText()
  console.log(`  报告阶段文字: ${JSON.stringify(reportText.slice(0, 120))}`)
  check('1) 报告阶段标题是「底层工作区缺失」', reportText.includes('底层工作区缺失'), reportText.slice(0, 60))
  check('8) 报告阶段只有 1 个弹窗', await dialogCount() === 1, `${String(await dialogCount())} 个`)

  await dialogs().getByRole('button', { name: '重建该工作区' }).first().click({ force: true })
  await page.waitForTimeout(1200)
  const confirmText = await dialogText()
  console.log(`  确认阶段文字: ${JSON.stringify(confirmText.slice(0, 160))}`)
  check('1) 进入确认阶段（标题变化）', confirmText.includes('确认重建'), confirmText.slice(0, 60))
  check('1) 内容含警告文案', confirmText.includes('创建目录'), confirmText.slice(0, 160))
  check('2) 确认阶段显示目标路径', confirmText.includes(target), confirmText.slice(0, 200))
  check('8) 确认阶段仍然只有 1 个弹窗（没有嵌套 Modal）', await dialogCount() === 1,
    `${String(await dialogCount())} 个`)

  console.log('')
  console.log('=== 9. 警告行的排版（图标与文本对齐、卡片高度不虚增）===')
  // Regression guard for a rule I missed when copying `RiskConfirmation`'s warning: no `.warning p`
  // equivalent, so the paragraph kept the browser default `margin-block: 1em`. With
  // `align-items: flex-start` that pushed the text below the icon, and because flex does not
  // collapse margins it also added ~2 × 1em to the card's height. Both were reported as separate
  // bugs; they were one cause, so both are asserted here.
  const layout = await page.evaluate(() => {
    const card = document.querySelector('[role="dialog"][aria-modal="true"]')
    if (card === null) return null
    // Targeted by class, not by "first div holding an svg and a p": the dialog's own content div
    // also holds both (the header's close button contains an svg), and picking that measured the
    // card's root instead of the warning row — reported as a 53px offset that was an artifact.
    // A `div` qualifier excludes `baseMissingConfirmIcon`, which is the svg.
    const warning = card.querySelector('div[class*="baseMissingConfirm"]')
    if (warning === null) return null
    const paragraph = warning.querySelector('p')
    const icon = warning.querySelector('svg')
    if (paragraph === null || icon === null) return null
    const top = warning.getBoundingClientRect().top
    const style = getComputedStyle(paragraph)
    return {
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      warningHeight: Math.round(warning.getBoundingClientRect().height * 100) / 100,
      textTop: Math.round((paragraph.getBoundingClientRect().top - top) * 100) / 100,
      iconTop: Math.round((icon.getBoundingClientRect().top - top) * 100) / 100,
    }
  })
  console.log(`  ${JSON.stringify(layout)}`)
  check('9) 段落没有默认外边距（漏抄的规则已补上）',
    layout !== null && Number.parseFloat(layout.marginTop) === 0 && Number.parseFloat(layout.marginBottom) === 0,
    `margin ${String(layout?.marginTop)} / ${String(layout?.marginBottom)}`)
  // The icon carries `margin-top: 2px` on purpose (it matches `RiskConfirmation`'s `.warningIcon`),
  // so the two are aligned when the text is exactly 2px below the row's top edge.
  check('9) 图标与文本顶部对齐（相差 2px，来自图标自身的 margin-top）',
    layout !== null && Math.abs(layout.textTop - layout.iconTop) <= 3,
    `文本 ${String(layout?.textTop)} vs 图标 ${String(layout?.iconTop)}`)
  // Two lines at the 380px card width, so 44px is the correct height, not a symptom: 2 × 22px
  // line-height, with the paragraph's margin now contributing nothing. Asserted as a bound rather
  // than a single value, because the copy differs per locale.
  //
  // Tolerance, not `% 22 === 0`: `warningHeight` is a rounded float, so sub-pixel layout
  // rounding (43.99 or 44.01) made a strict modulo fail on a correct card. The inflation this
  // guards against is a whole `1em` margin, which is still far outside a 1px band.
  const heightError = layout === null
    ? null
    : Math.abs(layout.warningHeight - Math.round(layout.warningHeight / 22) * 22)
  check('9) 警告行高度只由文本决定（无 margin 虚增）',
    layout !== null && layout.warningHeight > 0 && heightError <= 1,
    `行高 ${String(layout?.warningHeight)}px（应为 22px 的整数倍，偏差 ${String(heightError)}px）`)

  console.log('')
  console.log('=== 3. 焦点应在「确认重建」按钮上 ===')
  const focused = await page.evaluate(() => {
    const node = document.activeElement
    if (node === null) return { tag: null, text: null }
    return { tag: node.tagName.toLowerCase(), text: (node.textContent ?? '').trim() }
  })
  console.log(`  焦点元素: ${JSON.stringify(focused)}`)
  check('3) 焦点转移到确认按钮', focused.text === '确认重建', JSON.stringify(focused))

  console.log('')
  console.log('=== 4. 点「返回」⇒ 回到报告阶段，弹窗不关 ===')
  await dialogs().getByRole('button', { name: '返回' }).first().click({ force: true })
  await page.waitForTimeout(1000)
  const backText = await dialogText()
  console.log(`  返回后文字: ${JSON.stringify(backText.slice(0, 80))}`)
  check('4) 回到报告阶段', backText.includes('底层工作区缺失'), backText.slice(0, 60))
  check('4) 弹窗未关闭', await dialogCount() === 1, `${String(await dialogCount())} 个`)

  console.log('')
  console.log('=== 5. 确认阶段按 Escape ⇒ 返回（不关闭）===')
  await dialogs().getByRole('button', { name: '重建该工作区' }).first().click({ force: true })
  await page.waitForTimeout(1000)
  check('5) 前提：已在确认阶段', (await dialogText()).includes('确认重建'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  const afterEsc = await dialogText()
  console.log(`  Escape 后: ${JSON.stringify(afterEsc.slice(0, 80))}`)
  check('5) Escape 回到报告阶段而非关闭', await dialogCount() === 1 && afterEsc.includes('底层工作区缺失'),
    `${String(await dialogCount())} 个: ${afterEsc.slice(0, 50)}`)

  console.log('')
  console.log('=== 6. 报告阶段按 Escape ⇒ 关闭（无回归）===')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  console.log(`  剩余弹窗: ${String(await dialogCount())}`)
  check('6) 报告阶段 Escape 关闭弹窗', await dialogCount() === 0, `${String(await dialogCount())} 个`)

  console.log('')
  console.log('=== 7. 走完确认 ⇒ 目录创建 + 注册成功 ===')
  const raisedAgain = await raiseReport()
  check('7) 报告再次出现', raisedAgain === true)
  await dialogs().getByRole('button', { name: '重建该工作区' }).first().click({ force: true })
  await page.waitForTimeout(1000)
  await dialogs().getByRole('button', { name: '确认重建' }).first().click({ force: true })
  await page.waitForTimeout(7000)
  await dismiss()
  console.log(`  目录存在: ${String(existsSync(target))}  弹窗: ${String(await dialogCount())}`)
  const row = registry().find(entry => entry.path === target)
  console.log(`  注册行: ${JSON.stringify(row)}  设置: ${JSON.stringify(storedBase())}`)
  check('7) 目录已创建', existsSync(target))
  check('7) 已注册为工作区', row !== undefined)
  check('7) 弹窗已关闭', await dialogCount() === 0, `${String(await dialogCount())} 个`)
  // The whole sequence is swept here: the earlier per-step assertions only say the count was
  // right at those moments, so a second dialog that appeared *between* two samples would have
  // gone unnoticed.
  const maxDialogs = observedDialogCounts.length === 0 ? 0 : Math.max(...observedDialogCounts)
  check('8) 全程没有出现第二个弹窗', maxDialogs <= 1,
    `全程最大 dialog 数=${String(maxDialogs)}（采样 ${String(observedDialogCounts.length)} 次）`)

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  if (child !== undefined) child.kill() // guarded: a synchronous `spawn` throw leaves it unset
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
process.exit(failures.length === 0 ? 0 : 1)
