/**
 * Prove the flash-and-revert mechanism, and that the failure is silent.
 *
 * Timeline evidence says the user's host process is stale (started 08:08, while steps ①
 * and ② were written at 11:03 and 11:50), so its `setBaseWorkspace` does not exist while
 * the browser loads the new client bundle from disk on every page load. This reproduces
 * that pairing deterministically by failing only that one endpoint, which is exactly what a
 * host without the method does — without having to swap bundles or restart anything.
 *
 * Expected mechanism, asserted here:
 *   1. `ProjectModel.setBaseWorkspace` writes optimistically, so the card **paints 指定**
 *      (the flash);
 *   2. the RPC fails, so the catch reverts, and because nothing superseded the value the
 *      revert lands — the card **snaps back to 默认**;
 *   3. the revert clears `path`, so the next click on 指定 takes the "no path yet" branch
 *      and **reopens the chooser** — the loop the user described.
 *
 * It also logs what the user was told: if nothing visible appears, the revert is silent,
 * which is a real defect independent of the stale host (a rejected write must not look
 * like a mysterious flicker).
 *
 * Usage: node probe-base-workspace-revert-mechanism.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-revert-mechanism.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17930 : 17931
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

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
const context = await browser.newContext()
// Fail ONLY the step-② write, the way a host without that method behaves. Everything
// else — including `baseline`, which is what paints the row — still works.
//
// Stubbed at the **route** layer rather than by replacing `window.fetch`: the client
// wraps fetch during boot, so an init-script wrapper is bypassed (measured — the write
// landed and the stub never ran). `route` intercepts whatever transport the app uses.
let stubbedCalls = 0
await context.route('**/api/projectGroups/setBaseWorkspace', async (route) => {
  stubbedCalls += 1
  // Delayed on purpose: the optimistic paint and the revert are otherwise inside one
  // round trip, and a fast local failure can complete before the first sample. A slow
  // host is the realistic case this reproduces (a cold process answering after boot).
  await new Promise(resolve => setTimeout(resolve, 700))
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      type: 'server-response',
      rpcId: 'stubbed',
      result: { ok: false, error: { code: 'not-found', message: 'method not found' } },
    }),
  })
})
const page = await context.newPage()
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
const warnings = []
page.on('console', (message) => {
  if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text())
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

const card = () => page.locator('[data-plugin-config]').first()
const pressed = async () => {
  const cubes = card().locator('button[aria-pressed]')
  if (await cubes.count() !== 2) return null
  const states = await cubes.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-pressed')))
  return { default: states[0], specified: states[1] }
}
const storedBase = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
    return parsed.global?.baseWorkspace ?? null
  } catch {
    return null
  }
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  await page.evaluate(async () => {
    const token = new URL(location.href).searchParams.get('token') ?? ''
    await fetch(`${location.origin}/api/workspace/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'w', method: 'workspace/create',
        payload: { args: { request: { path: 'C:\\Users\\Think\\Desktop\\项目\\dsh-project-groups\\scripts' } } },
      }),
    })
  })

  await dismiss()
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  await page.locator('text=dsh-project-groups').first().click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()

  console.log(`初始: ${JSON.stringify(await pressed())}  disk=${JSON.stringify(storedBase())}`)

  console.log('')
  console.log('=== 手势：点「指定工作区」→ 选一行 → 确认（写入会被拒绝）===')
  const specifiedCard = card().locator('button[aria-pressed]').filter({ hasText: '指定工作区' }).first()
  await specifiedCard.click({ force: true })
  await page.waitForTimeout(1500)
  const chooser = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
  await chooser.locator('[role="option"]').first().click({ force: true })
  await page.waitForTimeout(500)
  await chooser.getByRole('button', { name: '确认' }).first().click({ force: true })

  // Sample fast enough to catch the optimistic paint before the revert.
  console.log('')
  console.log('=== 每 50ms 采样 3s（捕捉"闪一下"）===')
  const trace = []
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(50)
    const state = await pressed()
    const key = state === null ? '?' : `${state.default}/${state.specified}`
    if (trace.length === 0 || trace[trace.length - 1].key !== key) {
      trace.push({ t: (i * 0.05).toFixed(2), key })
      console.log(`  t=${(i * 0.05).toFixed(2)}s  默认=${String(state?.default)} 指定=${String(state?.specified)}`)
    }
  }

  const sawSpecified = trace.some(step => step.key === 'false/true')
  const endedDefault = trace[trace.length - 1]?.key === 'true/false'
  console.log('')
  check('0) 桩确实拦到了写请求', stubbedCalls > 0, `拦截 ${String(stubbedCalls)} 次`)
  check('1) 先闪到「指定」（乐观写入生效）', sawSpecified, JSON.stringify(trace.map(t => `${t.t}s:${t.key}`)))
  check('2) 随后跳回「默认」（失败回滚）', endedDefault, `最终 ${String(trace[trace.length - 1]?.key)}`)
  check('3) 磁盘上没有写入（host 从未接受）', storedBase() === null, JSON.stringify(storedBase()))

  console.log('')
  console.log('=== 4. 再点「指定工作区」：又是弹窗（用户说的循环）===')
  await specifiedCard.click({ force: true })
  await page.waitForTimeout(1500)
  const reopened = await chooser.count()
  check('4) 又是弹窗而不是直接选中', reopened === 1, `chooser=${String(reopened)}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  console.log('')
  console.log('=== 5. 用户看到了什么解释 ===')
  const visibleAlerts = await page.locator('[role="alert"], [role="note"]').allInnerTexts().catch(() => [])
  console.log(`  页面上的 alert/note: ${JSON.stringify(visibleAlerts)}`)
  console.log(`  console 警告: ${JSON.stringify(warnings.slice(0, 4))}`)
  check('5) 写失败**没有**被静默吞掉（用户能知道原因）',
    visibleAlerts.some(text => text.trim() !== '') || warnings.some(w => /reject|失败|fail/i.test(w)),
    `alerts=${JSON.stringify(visibleAlerts)} warns=${String(warnings.length)}`)

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
