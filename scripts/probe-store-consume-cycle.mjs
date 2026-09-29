/**
 * Does `createSnapshotStore.set(x)` notify when the value is already `x`?
 *
 * Measured **in the browser**, which is the only place this module can run: it is an ESM module
 * importing `zustand/vanilla`, resolved by the client's own bundle graph, so Node cannot load it
 * (measured: `ERR_MODULE_NOT_FOUND: Cannot find package 'zustand'`, and zustand exists nowhere in
 * the install).
 *
 * `window.__ModuleLoader__` only exposes `load({id, factory})` — there is no accessor for an
 * already-loaded module (measured), so the store cannot be fetched by id from the page. Instead
 * this observes the semantics through a **real store already in the running app**: the missing-
 * workspace request store (`baseWorkspaceRequest`), which is a `createSnapshotStore<… | null>`
 * whose value the dialog consumes exactly as 3a's chooser request will be.
 *
 * Method: force the dialog open (delete the base workspace, then click New Session), cancel it,
 * and force it open a second time. If the second open works, then a `null → object` transition
 * after consumption notifies — the property 3a actually depends on. Whether an *unchanged* value
 * notifies is then inferred from the implementation contract: `set` routes to zustand's
 * `setState(next, true)`.
 *
 * Usage: node probe-store-consume-cycle.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-store-consume-cycle.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17995 : 17996
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
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${out.slice(-1200)}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

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
  const parsed = JSON.parse(await response.text())
  return parsed?.result?.value
}, { method, args })

const dialog = () => page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '底层工作区缺失' })
const newSession = () => page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 准备：让默认工作区解析失败，从而复现弹窗 ===')
  const initial = await rpc('workspace/initializeDefault', {})
  const workspace = initial?.workspace ?? null
  console.log(`  默认工作区: ${String(workspace?.path)}`)
  check('拿到默认工作区', workspace !== null)
  const deleted = await rpc('workspace/delete', { request: { workspaceId: workspace.workspaceId } })
  check('已删除其注册', deleted?.deleted === true)

  console.log('')
  console.log('=== 1. 第一次点击 ⇒ 弹窗出现（store: null → request）===')
  await newSession().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  const first = await dialog().count()
  check('第一次弹窗出现', first === 1, `${String(first)} 个`)

  console.log('')
  console.log('=== 2. 取消 ⇒ 消费（store: request → null）===')
  await page.getByRole('button', { name: '取消', exact: true }).last().click({ force: true })
  await page.waitForTimeout(1200)
  check('取消后弹窗关闭', await dialog().count() === 0)

  console.log('')
  console.log('=== 3. 第二次点击 ⇒ 弹窗应再次出现（这证明 null → request 会通知）===')
  await newSession().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  const second = await dialog().count()
  check('第二次弹窗再次出现', second === 1, `${String(second)} 个`)

  console.log('')
  console.log('=== 4. 第三次 ⇒ 确认可重复（不是只成功一次）===')
  await page.getByRole('button', { name: '取消', exact: true }).last().click({ force: true })
  await page.waitForTimeout(1000)
  await newSession().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  const third = await dialog().count()
  check('第三次仍能出现', third === 1, `${String(third)} 个`)

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
