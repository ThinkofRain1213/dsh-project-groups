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
 * after consumption notifies — the property 3a actually depends on.
 *
 * **What is NOT empirically established here.** The header used to claim this measures whether
 * `set(x)` notifies when the value is *already* `x`. It does not: every observed transition is
 * `null → object`, because closing the dialog consumes the request back to `null`. The
 * unchanged-value case is therefore *inferred* from the implementation contract (`set` routes to
 * zustand's `setState(next, true)`), not measured — and this probe must not be cited as evidence
 * for it. The module cannot be imported here either way: it is ESM importing `zustand/vanilla`,
 * resolved only by the client's own bundle graph, and `window.__ModuleLoader__` exposes
 * `load({id, factory})` with no accessor for an already-loaded module.
 *
 * Usage: node probe-store-consume-cycle.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-store-consume-cycle.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// `join` rather than a hand-written `\\` path, and an overridable port: the literal only
// worked on Windows, and a port already in use surfaced as a boot timeout rather than as
// the collision it was.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17995 : 17996))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/**
 * How long to wait for `dialog().count()` to reach the expected value.
 *
 * The steps below used to assert on a fixed `waitForTimeout(5000)` — a race, because a
 * loaded machine can still be mid-render when the sleep ends, and the failure then reads
 * as "the store did not notify" rather than "the UI was not ready". This returns as soon
 * as the UI reaches the expected count and still gives the slow case headroom.
 */
const UI_SETTLE_TIMEOUT_MS = 15_000
const UI_POLL_INTERVAL_MS = 200

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
// The child is killed in the `finally` below, which used to be reached only after this
// promise resolved — a boot timeout therefore leaked the dsh process and its port, and
// the rejection surfaced as an unhandled top-level error.
const bootUrl = () => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill()
    reject(new Error(`boot timeout:\n${redactToken(out.slice(-1200))}`))
  }, 120_000)
  // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
  // stdout, so without this handler the promise stayed pending until the 120 s timeout and
  // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
  // the process outright.
  child.on('error', (error) => {
    clearTimeout(timer)
    reject(new Error(`spawn failed for ${exe}: ${error.message}`))
  })
  // An early exit (bad args, the port already bound, a crash) also never prints a URL.
  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    reject(new Error(`dsh exited before printing a URL (code=${String(code)}, signal=${String(signal)}):\n${redactToken(out.slice(-1200))}`))
  })
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
})

let browser
let page

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

/**
 * One RPC call, reported rather than thrown.
 *
 * Previously the status was ignored, `JSON.parse` could throw on a non-JSON error body, and an
 * RPC-level `error` was mapped straight to `undefined` — so a failed call looked like empty data
 * and the failure only surfaced later as a confusing downstream symptom.
 */
const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
  try {
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
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${String(response.status)} ${text.slice(0, 160)}` }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, status: response.status, error: `non-JSON body ${text.slice(0, 160)}` }
    }
    // An RPC-level error is surfaced as one, not folded into `undefined`.
    if (parsed?.result?.error !== undefined) {
      return { ok: false, status: response.status, error: JSON.stringify(parsed.result.error).slice(0, 200) }
    }
    return { ok: true, status: response.status, error: null, value: parsed?.result?.value }
  } catch (error) {
    return { ok: false, status: 0, error: `fetch/parse failed: ${error.message}` }
  }
}, { method, args })

const dialog = () => page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '底层工作区缺失' })
const newSession = () => page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()

/** Poll the dialog count until it reaches `want`, then report what it actually is. */
async function waitForDialogCount(want) {
  const deadline = Date.now() + UI_SETTLE_TIMEOUT_MS
  let count = await dialog().count()
  while (count !== want && Date.now() < deadline) {
    await page.waitForTimeout(UI_POLL_INTERVAL_MS)
    count = await dialog().count()
  }
  return count
}

try {
  const url = await bootUrl()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 准备：让默认工作区解析失败，从而复现弹窗 ===')
  const initial = await rpc('workspace/initializeDefault', {})
  const workspace = initial.ok ? (initial.value?.workspace ?? null) : null
  if (!initial.ok) console.log(`  initializeDefault 调用失败: ${String(initial.error)}`)
  console.log(`  默认工作区: ${String(workspace?.path)}`)
  check('拿到默认工作区', workspace !== null && workspace !== undefined,
    String(workspace?.path ?? initial.error ?? '(no workspace)'))
  // Bail out with a descriptive throw rather than dereferencing a missing workspace:
  // `workspace.workspaceId` on undefined aborted the probe with a TypeError instead of
  // reporting a clean failure, and `undefined !== null` made the check above wrongly PASS.
  if (workspace === null) throw new Error('no default workspace to work with — steps 1-4 depend on it')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: workspace.workspaceId } })
  check('已删除其注册', deleted.ok && deleted.value?.deleted === true, deleted.error ?? JSON.stringify(deleted.value))

  console.log('')
  console.log('=== 1. 第一次点击 ⇒ 弹窗出现（store: null → request）===')
  await newSession().click({ force: true })
  const first = await waitForDialogCount(1)
  await dismiss()
  check('第一次弹窗出现', first === 1, `${String(first)} 个`)

  console.log('')
  console.log('=== 2. 取消 ⇒ 消费（store: request → null）===')
  await page.getByRole('button', { name: '取消', exact: true }).last().click({ force: true })
  check('取消后弹窗关闭', await waitForDialogCount(0) === 0)

  console.log('')
  console.log('=== 3. 第二次点击 ⇒ 弹窗应再次出现（这证明 null → request 会通知）===')
  await newSession().click({ force: true })
  const second = await waitForDialogCount(1)
  await dismiss()
  check('第二次弹窗再次出现', second === 1, `${String(second)} 个`)

  console.log('')
  console.log('=== 4. 第三次 ⇒ 确认可重复（不是只成功一次）===')
  await page.getByRole('button', { name: '取消', exact: true }).last().click({ force: true })
  await waitForDialogCount(0)
  await newSession().click({ force: true })
  const third = await waitForDialogCount(1)
  await dismiss()
  check('第三次仍能出现', third === 1, `${String(third)} 个`)

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
process.exit(failures.length === 0 ? 0 : 1)
