/**
 * Does `session/create` with a `cwd` re-file a Session under the Workspace that owns
 * that directory?
 *
 * The user wants a "重建该工作区" action for a specified Workspace that was deleted
 * from the official sidebar. Re-registering the path produces a **new** Workspace id
 * with an **empty** `sessionIds` (measured earlier), so merely re-creating the
 * registration does not bring the Sessions back under it. But `ISessions.create`
 * documents itself as "Create or **adopt** a Session on the Host" and accepts a
 * `cwd`, which suggests a Session created at that directory may be filed into the
 * Workspace owning it — the same mechanism that puts a plugin-created Session under
 * the default Workspace in the first place.
 *
 * The distinction this measures is narrow and load-bearing:
 *
 *   - if a Session created with `cwd` lands in the Workspace whose path matches, then
 *     a re-created Workspace can be repopulated one Session at a time, and
 *     "重建该工作区" means something;
 *   - if it does not, re-creating a Workspace is permanently empty and the honest
 *     action is "更换" rather than "重建".
 *
 * Existing Sessions are not adopted here — only a newly created one is observed, so
 * the probe cannot damage anything.
 *
 * Usage: node probe-session-cwd-adoption.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-session-cwd-adoption.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17830 : 17831
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
  } catch { /* raw text printed */ }
  return { status: response.status, text, value: parsed?.result?.value, ok: parsed?.result?.ok, error: parsed?.result?.error }
}, { method, args })

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)

  console.log('=== 1. 默认工作区（一个已注册的、带 path 的工作区）===')
  const first = await rpc('workspace/initializeDefault', {})
  const workspace = first.value?.workspace ?? null
  if (workspace === null) throw new Error(`no default workspace: ${first.text.slice(0, 200)}`)
  console.log(`  id=${String(workspace.workspaceId)}`)
  console.log(`  path=${workspace.path}`)
  console.log(`  sessionIds=${JSON.stringify(workspace.sessionIds)}`)

  console.log('')
  console.log('=== 2. 删注册（保留目录），再重新注册同一 path ===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: workspace.workspaceId } })
  console.log(`  删除: ok=${String(deleted.ok)}`)
  const recreated = await rpc('workspace/create', { request: { path: workspace.path } })
  const fresh = recreated.value?.workspace ?? null
  console.log(`  重注册: ok=${String(recreated.ok)}  created=${String(recreated.value?.created)}`)
  console.log(`  新 id=${String(fresh?.workspaceId)}  sessionIds=${JSON.stringify(fresh?.sessionIds)}`)

  console.log('')
  console.log('=== 3. 用该 path 作 cwd 建一个会话 ===')
  const created = await rpc('session/create', { request: { cwd: workspace.path } })
  console.log(`  ok=${String(created.ok)}`)
  console.log(`  响应: ${created.text.slice(0, 300)}`)

  console.log('')
  console.log('=== 4. 那个新会话归属哪个工作区 ===')
  // Reading the registry directly is the only way to see which Workspace claimed it;
  // the RPC surface has no workspace/list (measured earlier: `not found`).
  const sessions = await page.evaluate(async () => {
    const token = new URL(location.href).searchParams.get('token') ?? ''
    const response = await fetch(`${location.origin}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'sl', method: 'session/list', payload: { args: { _request: {} } },
      }),
    })
    const body = await response.json()
    const items = body?.result?.value?.sessions ?? []
    return items.map(item => ({ id: item.sessionId, cwd: item.cwd, blank: item.blank }))
  })
  console.log(`  Host 会话:`)
  for (const item of sessions) console.log(`    ${JSON.stringify(item)}`)

  const newId = created.value?.sessionId ?? null
  console.log(`  新建的会话 id: ${String(newId)}`)
  const landed = sessions.find(item => item.id === newId) ?? null
  console.log(`  其 cwd: ${String(landed?.cwd)}`)
  console.log(`  cwd 是否等于工作区 path: ${landed?.cwd === workspace.path}`)

  console.log('')
  console.log('=== 判定 ===')
  console.log('  重新注册得到空 sessionIds（前次实测）⇒ 仅重建注册不会带回旧会话。')
  console.log('  本探针测的是另一条路：新建的会话能否挂到该工作区账下。')
  console.log(`  ⇒ ${landed !== null && landed.cwd === workspace.path
    ? 'cwd 生效：该工作区可以重新积累会话（但旧会话仍不在其账下）'
    : 'cwd 未体现，需进一步核对'}`)
} finally {
  running.kill()
  await browser.close()
}
