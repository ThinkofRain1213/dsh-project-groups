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
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-plus-routing.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17960 : 17961
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const calls = []
page.on('response', (response) => {
  const target = response.url()
  if (!target.includes('/api/')) return
  const method = target.split('/api/')[1]
  if (!/^(workspace|session|projectGroups)\//.test(method)) return
  calls.push(method)
})

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

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
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
  running.kill()
  await browser.close()
}
