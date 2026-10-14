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
 * Existing Sessions are not adopted here — only a newly created one is observed. This probe is
 * still NOT read-only against the DSH_HOME it is given: section 2 deletes the default
 * Workspace's registration and re-creates it, and section 3 creates a real Session in that
 * directory. Point it at a disposable probe home, not at a home you care about.
 *
 * Usage: node probe-session-cwd-adoption.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-session-cwd-adoption.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a leaked Host from an earlier failed run keeps this port bound, and the only
// symptom would be an opaque "boot timeout".
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17830 : 17831))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

let child
let browser
let page

/**
 * Boot the Host and resolve the tokenised dev-server URL.
 *
 * A function, not top-level code, so the boot path runs inside the try/finally below: a boot
 * timeout used to reject before the guarded region was entered, so the spawned Host was never
 * killed and kept the fixed port bound for every later run.
 */
const boot = async () => {
  child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  return new Promise((resolve, reject) => {
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
}

/**
 * Compare filesystem paths across separator style, case and a trailing separator: an exact `===`
 * on a Windows path reports "different" for two spellings of the same directory, which flipped
 * this probe's verdict to “需进一步核对”.
 */
const normalizePath = (value) => String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

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
  // `sessions` is the documented shape; `items` the fallback the sibling readopt probe accepts,
  // because a shape difference here used to make this section report an empty Host list.
  const value = parsed?.result?.value
  return {
    status: response.status,
    text,
    value,
    items: value?.sessions ?? value?.items ?? null,
    ok: parsed?.result?.ok,
    error: parsed?.result?.error,
  }
}, { method, args })

/**
 * A setup RPC. `ok` is asserted rather than printed: a rejected create/delete leaves the probe
 * measuring a state that was never established, and it still printed a confident 判定.
 */
const setup = async (label, method, args) => {
  const result = await rpc(method, args)
  const passed = result.status === 200 && result.ok !== false
  console.log(`${passed ? 'PASS' : 'FAIL'}  前置：${label} — status=${String(result.status)} ok=${String(result.ok)} error=${JSON.stringify(result.error)}`)
  if (!passed) throw new Error(`${label} failed (status=${String(result.status)}, ok=${String(result.ok)}, error=${JSON.stringify(result.error)}): ${result.text.slice(0, 200)}`)
  return result
}

try {
  const url = await boot()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)

  console.log('=== 1. 默认工作区（一个已注册的、带 path 的工作区）===')
  const first = await setup('workspace/initializeDefault', 'workspace/initializeDefault', {})
  const workspace = first.value?.workspace ?? null
  if (workspace === null) throw new Error(`no default workspace: ${first.text.slice(0, 200)}`)
  console.log(`  id=${String(workspace.workspaceId)}`)
  console.log(`  path=${workspace.path}`)
  console.log(`  sessionIds=${JSON.stringify(workspace.sessionIds)}`)

  console.log('')
  console.log('=== 2. 删注册（保留目录），再重新注册同一 path ===')
  await setup('workspace/delete', 'workspace/delete', { request: { workspaceId: workspace.workspaceId } })
  const recreated = await setup('workspace/create', 'workspace/create', { request: { path: workspace.path } })
  const fresh = recreated.value?.workspace ?? null
  console.log(`  重注册: created=${String(recreated.value?.created)}`)
  console.log(`  新 id=${String(fresh?.workspaceId)}  sessionIds=${JSON.stringify(fresh?.sessionIds)}`)

  console.log('')
  console.log('=== 3. 用该 path 作 cwd 建一个会话 ===')
  const created = await setup('session/create', 'session/create', { request: { cwd: workspace.path } })
  console.log(`  响应: ${created.text.slice(0, 300)}`)

  console.log('')
  console.log('=== 4. 那个新会话归属哪个工作区 ===')
  const sessions = await rpc('session/list', { _request: {} })
  const list = sessions.items ?? []
  console.log(`  Host 会话:`)
  for (const item of list) console.log(`    ${JSON.stringify({ id: item.sessionId, cwd: item.cwd, blank: item.blank })}`)

  const newId = created.value?.sessionId ?? null
  console.log(`  新建的会话 id: ${String(newId)}`)
  const landed = list.find(item => item.sessionId === newId) ?? null
  console.log(`  其 cwd: ${String(landed?.cwd)}`)
  console.log(`  cwd 是否等于工作区 path（归一化后）: ${normalizePath(landed?.cwd) === normalizePath(workspace.path)}`)

  // Ownership is the actual question, and `cwd` cannot answer it: `cwd` is an input echoed back
  // by `session/create`, so a Session can carry the right cwd and still be filed under a
  // different Workspace. Re-reading the same registration (`workspace/create` on an existing
  // path returns it with `created: false`) is how the owning Workspace's `sessionIds` is read
  // back; the new Session id has to appear there for "adopted" to be true.
  const reread = await rpc('workspace/create', { request: { path: workspace.path } })
  const ownerNow = reread.value?.workspace ?? null
  const ownedIds = Array.isArray(ownerNow?.sessionIds) ? ownerNow.sessionIds : null
  const adopted = newId !== null && ownedIds !== null && ownedIds.includes(newId)
  console.log(`  该工作区现在的 sessionIds: ${JSON.stringify(ownedIds)}`)
  console.log(`  新会话 id 是否在其中: ${adopted}`)

  console.log('')
  console.log('=== 判定 ===')
  console.log('  重新注册得到空 sessionIds（前次实测）⇒ 仅重建注册不会带回旧会话。')
  console.log('  本探针测的是另一条路：新建的会话能否挂到该工作区账下。')
  console.log(`  ⇒ ${adopted
    ? 'cwd 生效：该工作区可以重新积累会话（但旧会话仍不在其账下）'
    : '新会话没有出现在该工作区的 sessionIds 里：仅有相同 cwd 不构成归属，需进一步核对'}`)
} finally {
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
