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
 * Usage: node probe-initialize-default-after-delete.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-initialize-default-after-delete.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17800 : 17801
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

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
const page = await browser.newPage()
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))

const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
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
}, { method, args })

/** The Workspace list, as the Host projects it. */
const listWorkspaces = () => page.evaluate(async () => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/workspace/follow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({ type: 'client-request', rpcId: 'w', method: 'workspace/follow', payload: { args: {} } }),
  })
  return (await response.text()).slice(0, 200)
})

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)

  console.log('=== 1. 首次解析默认工作区 ===')
  const first = await rpc('workspace/initializeDefault', {})
  const firstWorkspace = first.value?.workspace ?? null
  console.log(`  HTTP ${String(first.status)}  ok=${String(first.ok)}`)
  console.log(`  原始响应: ${first.text.slice(0, 400)}`)
  console.log(`  workspace=${JSON.stringify(firstWorkspace === null ? null : { id: firstWorkspace.workspaceId, path: firstWorkspace.path, title: firstWorkspace.title })}`)
  if (firstWorkspace === null) {
    // The refusal is the finding itself on a fresh profile: report it and stop,
    // rather than proceeding with a null and blaming a later step.
    console.log(`  ⇒ 解析不到默认工作区（错误码: ${String(first.error?.code ?? '(无)')}），后续步骤无法进行`)
    console.log(`  ⇒ 这本身说明：新 profile 上 initializeDefault 不能作为唯一解析路径`)
    throw new Error('no default workspace to work with')
  }
  const defaultPath = firstWorkspace.path
  const defaultId = firstWorkspace.workspaceId
  console.log(`  目录存在: ${existsSync(defaultPath)}`)

  console.log('')
  console.log('=== 2. 删除它的注册（保留目录）===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: defaultId } })
  console.log(`  ok=${String(deleted.ok)}  ${deleted.text.slice(0, 160)}`)
  console.log(`  目录是否还在: ${existsSync(defaultPath)}`)

  console.log('')
  console.log('=== 3. 再调 initializeDefault（注册已删、目录仍在）===')
  const second = await rpc('workspace/initializeDefault', {})
  console.log(`  ok=${String(second.ok)}  value=${JSON.stringify(second.value ?? null)}`)
  console.log(`  ⇒ ${second.value === null || second.value?.workspace === undefined ? '返回 undefined：没补建' : '竟然补建了'}`)

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
  console.log(`  create ok=${String(created.ok)}  id=${String(createdView?.workspaceId)}  created=${String(created.value?.created)}`)
  const fourth = await rpc('workspace/initializeDefault', {})
  console.log(`  initializeDefault ok=${String(fourth.ok)}  value=${JSON.stringify(fourth.value ?? null)}`)

  console.log('')
  console.log('=== 判定 ===')
  const step3Undefined = second.value === null || second.value?.workspace === undefined
  const step5Undefined = fourth.value === null || fourth.value?.workspace === undefined
  console.log(`  删除注册后 initializeDefault 失效: ${step3Undefined ? '✅ 是（永久禁用，符合代码）' : '❌ 否'}`)
  console.log(`  用 create 重新注册后仍失效        : ${step5Undefined ? '✅ 仍失效 ⇒ 插件必须改用【按路径解析】' : '❌ 变成可用了（那就可以继续用 initializeDefault）'}`)
  console.log(`  新注册的 id 与原 id 相同吗        : ${createdView?.workspaceId === defaultId ? '⚠️ 相同' : '否（新 id，defaultWorkspaceId 指向旧 id 故永不匹配）'}`)
} finally {
  running.kill()
  await browser.close()
}
