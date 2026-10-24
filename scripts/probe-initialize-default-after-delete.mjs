/**
 * Once the default Workspace's registration is deleted, is `initializeDefault` dead?
 *
 * This is the crux of the "rebuild the default Workspace" design, and code reading
 * says yes: `defaultWorkspaceId` is written in exactly one place (`createCanonical`
 * under its `firstUse` flag, which only `initializeDefault` sets) and is *never
 * cleared*. `initializeDefault` starts with
 *
 *     if (state.defaultWorkspaceId !== void 0) return this.entities.get(state.defaultWorkspaceId)
 *
 * so with the registration gone it returns `undefined` immediately — before any
 * eligibility check, before any directory resolution, and without repairing
 * anything. The domain's own comment confirms the intent ("retaining files and
 * Sessions", "permanently disables automatic creation").
 *
 * If that holds, a rebuilt Workspace registered through the public `create` path
 * will **not** be the default, and `initializeDefault` will keep returning
 * `undefined` forever — which means this plugin cannot rely on it as its only way
 * to resolve the base Workspace. That is a design-changing fact, so it is measured
 * rather than argued:
 *
 *   1. resolve the default Workspace (fresh profile, so it exists);
 *   2. delete its registration while keeping the directory;
 *   3. call `initializeDefault` again and report what comes back;
 *   4. re-create the directory and call it a third time — still nothing?
 *   5. register the path through the public `create` and call it a fourth time.
 *
 * Step 5 is the one that matters: if it is still `undefined`, resolution must move
 * to a path lookup.
 *
 * ## Why the verdict is gated on the call succeeding
 *
 * `value === undefined` is true both when `initializeDefault` legitimately yields no
 * workspace AND when the request itself failed (transport, permission, a non-200). A
 * broken call would therefore have been reported as the confirmed "永久禁用" finding and
 * the design conclusion drawn from it would be wrong. Every absence is now gated on
 * `ok && status === 200 && no error`, and the error code is printed in that branch.
 *
 * Usage: node probe-initialize-default-after-delete.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-initialize-default-after-delete.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// The port is an explicit input rather than a lookup keyed on the profile name: the old
// `profile === 'pg' ? 17800 : 17801` silently sent any other profile to 17801, where it
// would collide with whatever already held that port.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17800 : 17801))
// `join` rather than a hand-written `\\` path: the literal baked in a Windows-only asar
// layout, and a bad BIN surfaces as a boot timeout rather than as the path error it is.
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** How long to wait for the Host RPC to answer after a full page load. */
const READY_TIMEOUT_MS = 90_000
const READY_POLL_INTERVAL_MS = 1000
/** Bound on the retained boot log, which the timeout message slices anyway. */
const LOG_TAIL_CHARS = 16_000

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

let child
let out = ''
/** Append a chunk, keeping only the tail: dsh logs for the whole run and nothing reads the head. */
const appendLog = (chunk) => {
  out = (out + String(chunk)).slice(-LOG_TAIL_CHARS)
}
const bootUrl = () => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    // Kill before rejecting. This `await` used to sit outside the try/finally that kills the
    // child, so a boot timeout orphaned the dsh process (holding the port) and surfaced as an
    // unhandled top-level rejection.
    child.kill()
    reject(new Error(`boot timeout:\n${redactToken(out)}`))
  }, 120_000)
  // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
  // stdout, so without this handler the promise stayed pending until the 120 s timeout and
  // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
  // the process outright.
  child.on('error', (error) => {
    clearTimeout(timer)
    reject(new Error(`spawn failed for ${exe}: ${error.message}`))
  })
  // An early exit (bad args, the port already bound, a crash) also never prints a URL, and its
  // output is the only thing that explains why. Without this the run just sat for two minutes.
  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    reject(new Error(`dsh exited before printing a URL (code=${String(code)}, signal=${String(signal)}):\n${redactToken(out)}`))
  })
  child.stdout.on('data', (chunk) => {
    appendLog(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', appendLog)
})

let browser
let page

const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
  try {
    const token = new URL(location.href).searchParams.get('token') ?? ''
    const response = await fetch(`${location.origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `probe-${Math.random().toString(36).slice(2)}`,
        method,
        payload: { args },
      }),
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch { /* leave null; the raw text is printed */ }
    return { status: response.status, text, value: parsed?.result?.value, ok: parsed?.result?.ok, error: parsed?.result?.error }
  } catch (error) {
    return { status: 0, text: '', value: undefined, ok: false, error: { code: 'transport', message: error.message } }
  }
}, { method, args })

/** Whether a reply means "the call actually succeeded". */
const succeeded = (reply) => reply.status === 200 && reply.ok !== false && reply.error == null
/** Whether a successful reply carries no workspace. */
const absent = (reply) => succeeded(reply) && (reply.value === null || reply.value?.workspace === undefined)

try {
  // Spawned inside the `try` so the `finally` always reaches `child.kill()`. The timeout path
  // killed it itself, but a throw from `chromium.launch`/`newPage` between the two used to be
  // enough to leave the Host running on the port.
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
  const url = await bootUrl()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)

  console.log('=== 1. 首次解析默认工作区 ===')
  // The fixed 8-second sleep after `goto` was a race: on a loaded machine the Host is not
  // answering yet and the run reported `no default workspace to work with`, which reads as
  // the finding rather than as a slow start. `initializeDefault` is the call step 1 needs
  // anyway and it is idempotent, so it doubles as the readiness probe.
  const readyDeadline = Date.now() + READY_TIMEOUT_MS
  let first = await rpc('workspace/initializeDefault', {})
  while (!succeeded(first) && Date.now() < readyDeadline) {
    await page.waitForTimeout(READY_POLL_INTERVAL_MS)
    first = await rpc('workspace/initializeDefault', {})
  }
  const firstWorkspace = succeeded(first) ? (first.value?.workspace ?? null) : null
  console.log(`  等待 Host 就绪: ${succeeded(first) ? '已应答' : '超时'}`)
  console.log(`  HTTP ${String(first.status)}  ok=${String(first.ok)}`)
  console.log(`  原始响应: ${first.text.slice(0, 400)}`)
  console.log(`  workspace=${JSON.stringify(firstWorkspace === null ? null : { id: firstWorkspace.workspaceId, path: firstWorkspace.path, title: firstWorkspace.title })}`)
  if (firstWorkspace === null) {
    // The refusal is the finding itself on a fresh profile: report it and stop,
    // rather than proceeding with a null and blaming a later step.
    console.log(`  ⇒ 解析不到默认工作区（错误码: ${String(first.error?.code ?? '(无)')}），后续步骤无法进行`)
    console.log(`  ⇒ 这本身说明：新 profile 上 initializeDefault 不能作为唯一解析路径`)
    throw new Error(succeeded(first) ? 'no default workspace to work with' : `initializeDefault never answered: ${String(first.error?.message ?? first.error?.code ?? first.status)}`)
  }
  const defaultPath = firstWorkspace.path
  const defaultId = firstWorkspace.workspaceId
  console.log(`  目录存在: ${existsSync(defaultPath)}`)

  console.log('')
  console.log('=== 2. 删除它的注册（保留目录）===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: defaultId } })
  console.log(`  ok=${String(deleted.ok)}  ${deleted.text.slice(0, 160)}`)
  if (!succeeded(deleted)) {
    // Without this the later "still undefined" conclusions would be drawn against a
    // workspace that was never actually deleted.
    throw new Error(`workspace/delete failed (error=${String(deleted.error?.code ?? deleted.error?.message ?? deleted.status)}); step 3 would measure a stale registration`)
  }
  console.log(`  目录是否还在: ${existsSync(defaultPath)}`)

  console.log('')
  console.log('=== 3. 再调 initializeDefault（注册已删、目录仍在）===')
  const second = await rpc('workspace/initializeDefault', {})
  console.log(`  ok=${String(second.ok)}  status=${String(second.status)}  error=${String(second.error?.code ?? '(无)')}  value=${JSON.stringify(second.value ?? null)}`)
  if (!succeeded(second)) {
    console.log(`  ⇒ 调用失败（${String(second.error?.code ?? second.error?.message ?? second.status)}），这一步没有证明任何事`)
  } else {
    console.log(`  ⇒ ${absent(second) ? '返回 undefined：没补建' : '竟然补建了'}`)
  }

  console.log('')
  console.log('=== 4. （跳过）目录是否被重新创建 ===')
  // Deliberately NOT deleting the directory here.
  //
  // `defaultWorkspaceDirectory` derives from the OS Documents folder, so this path
  // is the operator's *real* `Documents\deepseek-harness\default-workspace` — shared
  // with their live profile even though DSH_HOME is isolated. `workspace/delete`
  // retains files by design and is safe; `rmSync` would not be.
  //
  // The step is also unnecessary: `initializeDefault` returns early on
  // `defaultWorkspaceId !== void 0`, *before* any directory resolution, so once
  // step 3 returns nothing, the missing-directory variant cannot behave differently.
  console.log(`  目录仍在（未删除，理由见源码注释）: ${existsSync(defaultPath)}`)

  console.log('')
  console.log('=== 5. 用公开 create 重新注册该路径，再次调用 ===')
  const created = await rpc('workspace/create', { request: { path: defaultPath } })
  const createdView = created.value?.workspace ?? null
  console.log(`  create ok=${String(created.ok)}  status=${String(created.status)}  id=${String(createdView?.workspaceId)}  created=${String(created.value?.created)}`)
  const fourth = await rpc('workspace/initializeDefault', {})
  console.log(`  initializeDefault ok=${String(fourth.ok)}  status=${String(fourth.status)}  error=${String(fourth.error?.code ?? '(无)')}  value=${JSON.stringify(fourth.value ?? null)}`)

  console.log('')
  console.log('=== 判定 ===')
  // Each verdict needs the call to have SUCCEEDED before "no workspace" means anything.
  // Reading `value === undefined` alone conflated "returned nothing" with "the RPC failed",
  // so a broken call would have been reported as the confirmed design finding.
  const step3Absent = absent(second)
  const step5Absent = absent(fourth)
  if (!succeeded(second)) {
    console.log(`  删除注册后 initializeDefault 失效: ⚠️ 未证实 —— 调用失败（${String(second.error?.code ?? second.error?.message ?? second.status)}）`)
  } else {
    console.log(`  删除注册后 initializeDefault 失效: ${step3Absent ? '✅ 是（永久禁用，符合代码）' : '❌ 否'}`)
  }
  if (!succeeded(fourth)) {
    console.log(`  用 create 重新注册后仍失效        : ⚠️ 未证实 —— 调用失败（${String(fourth.error?.code ?? fourth.error?.message ?? fourth.status)}）`)
  } else {
    console.log(`  用 create 重新注册后仍失效        : ${step5Absent ? '✅ 仍失效 ⇒ 插件必须改用【按路径解析】' : '❌ 变成可用了（那就可以继续用 initializeDefault）'}`)
  }
  if (!succeeded(created)) {
    console.log(`  create 是否成功                    : ⚠️ 失败（${String(created.error?.code ?? created.error?.message ?? created.status)}），故上面一行不构成证据`)
  }
  console.log(`  新注册的 id 与原 id 相同吗        : ${createdView?.workspaceId === defaultId ? '⚠️ 相同' : '否（新 id，defaultWorkspaceId 指向旧 id 故永不匹配）'}`)

  check('initializeDefault 在删除注册后返回 undefined（已证实调用成功）', step3Absent,
    succeeded(second) ? '返回了工作区' : `调用失败: ${String(second.error?.code ?? second.error?.message ?? second.status)}`)
  check('用 create 重新注册后 initializeDefault 仍失效（已证实调用成功）', step5Absent,
    succeeded(fourth) ? '返回了工作区' : `调用失败: ${String(fourth.error?.code ?? fourth.error?.message ?? fourth.status)}`)
} finally {
  if (child !== undefined) child.kill() // guarded: a synchronous `spawn` throw leaves it unset
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
