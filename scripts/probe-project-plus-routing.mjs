/**
 * Does a PROJECT row's ＋ go through the unscoped `startSession()` branch?
 *
 * This decides how much of ②.5's blast radius the scope statement was missing. Reading
 * `WorkspaceBrowser.tsx` says a project row calls `startSession(group.workspaceId, file)`,
 * and `tree.ts` builds caller-supplied groups with `workspaceId: undefined` — which would
 * mean project ＋ and Ungrouped ＋ reach the **same unscoped branch** as the sidebar button,
 * and therefore inherit the base-workspace routing too.
 *
 * That is a claim about behaviour, so it is measured: click a project's ＋ and watch for
 * `workspace/initializeDefault`, which only the official-default path calls. If it appears,
 * the project ＋ went unscoped.
 *
 * Usage: node probe-project-plus-routing.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-plus-routing.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17960 : 17961))
// `join`, not a literal: the escaped-backslash path cannot resolve off Windows, where the
// backslashes are ordinary filename characters and the spawn fails with an ENOENT.
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
// Created here, awaited inside the `try` below: awaiting it at the top level meant a boot
// timeout threw before the guarded region, so `child.kill()` in `finally` never ran and the
// host process was left as a zombie holding the port.
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
  child.stderr.on('data', (chunk) => { out += chunk })
})

let browser
let page
const calls = []

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

try {
  const url = await boot
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Registered after `newPage()`: this used to run against the `undefined` placeholder, so
  // the probe crashed before it clicked anything.
  page.on('response', (response) => {
    const target = response.url()
    if (!target.includes('/api/')) return
    const method = target.split('/api/')[1]
    if (!/^(workspace|session|projectGroups)\//.test(method)) return
    calls.push(method)
  })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 1. 建一个项目 ===')
  const stamp = Date.now().toString(36)
  const title = `探针${stamp}`
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(900)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  console.log(`  已创建: ${title}`)

  console.log('')
  console.log('=== 2. 点这个项目行的 ＋ ===')
  // The project row's own ⊕. Scoped by the row that carries the project title, so a
  // different row cannot be hit by accident.
  calls.length = 0
  const row = page.locator('div').filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) }).first()
  const plus = row.locator('button[aria-label*="新建会话"], button[aria-label*="新会话"]').first()
  const plusCount = await plus.count()
  console.log(`  行内 ＋ 命中: ${String(plusCount)}`)

  // The target is whichever locator actually matched, tracked as a value rather than
  // re-derived from a count — the earlier version keyed off `plusCount === 1` and got
  // both branches backwards:
  //
  //   - `plus` is already `.first()`, so `plus.count()` is only ever 0 or 1. When the
  //     row-scoped locator DID match, `plusCount === 1` sent `target` to the page-wide
  //     `.first()` button, discarding the row scoping this block exists to enforce —
  //     the click could land on the sidebar's own ＋ and the measurement would be of
  //     the wrong endpoint.
  //   - When the row scope matched nothing and the page-wide query found several,
  //     `plusCount` became that larger number, so `target` fell back to the zero-match
  //     `plus` and `click({ force: true })` timed out instead of failing with a reason.
  //
  // Choosing the locator first, then clicking it, removes the count from the decision.
  let target = plusCount > 0 ? plus : undefined
  if (target === undefined) {
    // Fall back to the page-level control, but only to locate it: the probe still needs
    // a ＋ that belongs to this project, so a page-wide match is reported as a failure
    // rather than clicked.
    const all = page.locator('button[aria-label*="新建会话"], button[aria-label*="新会话"]')
    const allCount = await all.count()
    console.log(`  行内未命中；全页 ＋ 数量: ${String(allCount)}`)
    if (allCount > 0) target = all.first()
  }
  console.log(`  项目行自己的 ＋ 是否命中: ${plusCount > 0 ? '是' : '否 ← 下面点的是全页控件，结论不可信'}`)
  if (target !== undefined) {
    // The row's ⊕ is a hover-revealed icon button: it resolves in the DOM but is not
    // actionable until the row is hovered, so clicking it cold times out even with
    // `force: true`. Every other probe that presses a row's ＋ hovers first
    // (`probe-two-project-plus.mjs` does exactly this), and this one was the exception —
    // which meant its click never landed at all.
    await row.hover({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(400)
    await target.click({ force: true })
  }
  await page.waitForTimeout(6000)
  await dismiss()

  console.log('  调用的端点:')
  for (const method of calls) console.log(`    ${method}`)

  const defaultResolved = calls.includes('workspace/initializeDefault')
  const created = calls.includes('session/create')
  console.log('')
  console.log('=== 3. 判读 ===')
  console.log(`  走了官方默认解析 (workspace/initializeDefault): ${String(defaultResolved)}`)
  console.log(`  创建了会话 (session/create): ${String(created)}`)
  if (defaultResolved) {
    console.log('  ⇒ 项目行的 ＋ 确实走 unscoped 分支 ⇒ ②.5 的路由对项目 ＋ 同样生效。')
  } else {
    console.log('  ⇒ 项目行的 ＋ 没走 unscoped 分支（带显式 workspaceId）。')
  }
} finally {
  child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
