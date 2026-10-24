/**
 * Can this desktop host create a directory over RPC at all?
 *
 * The default-workspace "补建" (rebuild) plan needs to create missing directories,
 * and the only client-reachable way to do that is `directoryPicker.createDirectory`.
 * But that verb is capability-gated: the controller serves it only when the
 * composed picker is the `browse` backend, and the desktop composition names
 * `@deepseek-ai/dsh-host-directory-picker-auto`, which resolves to `native` when
 * the operator is at the host's screen.
 *
 * So the plan is only viable if this host actually serves `browse`. That is a
 * runtime fact about this composition, not something to infer from the package
 * list, so it is measured directly: build a path that certainly does not exist,
 * call the verb, and report exactly what comes back.
 *
 * Three outcomes matter:
 *   - success                  → browse is composed; the plan is viable as designed
 *   - `directory-picker/unavailable` → native is composed; client-side mkdir is
 *     impossible and the design must change
 *   - anything else            → record it verbatim; do not guess
 *
 * A temp path is used, and the created directory is removed afterwards so the
 * check leaves no residue.
 *
 * Usage: node probe-directory-create-availability.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-directory-create-availability.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// `DSH_PROBE_PORT`/`join` rather than a pinned port and Windows-only separators: two probes
// run at once otherwise collide on the port, and the backslash literal is an invalid path on
// any host where `asarRoot` is a POSIX path.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17770 : 17771))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// Assigned inside the `try` below so that a failed spawn, a boot timeout or a launch error
// all still reach the `finally` that reaps it. While the spawn sat above the `try`, a boot
// timeout left the Electron Host holding `PORT` for every later run.
let child
let browser
let page

/**
 * Call one RPC method over the same wire the client uses.
 *
 * The path is `/api/<full method>` — the namespace is part of the method name
 * (`directoryPicker/list`), not a separate path segment. Getting that wrong returns
 * a bare `404 not found`, which is indistinguishable from a real refusal unless
 * something checks for it; hence the status and raw body are both printed.
 * @param method - full method name, e.g. `directoryPicker/list`.
 * @param args - named parameters of the remote method.
 * @returns `{ status, body }` — the raw HTTP status and body text, deliberately not parsed
 * here; or `{ transportError }` when no response arrived at all (gateway gone, reset).
 */
const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  try {
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
    return { status: response.status, body: await response.text() }
  } catch (error) {
    // Reported as a reading instead of rejecting the evaluate: this file's contract is that
    // "anything else → record it verbatim", and a transport failure is one of those outcomes.
    return { status: null, body: '', transportError: String(error?.message ?? error) }
  }
}, { method, args })

/**
 * Wait until the gateway answers HTTP at all.
 *
 * The `dsh web:` line is printed before the listener is necessarily accepting, and the fixed
 * 3 s settle that used to stand in for this was a race in both directions — a slow start met a
 * closed socket, a fast one wasted the time. Any HTTP status (including the 401/403 an
 * unauthenticated request gets) proves the listener is up.
 * @param target - the token URL scraped from the Host's stdout.
 * @param timeoutMs - how long to keep retrying.
 */
const waitForGateway = async (target, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  for (;;) {
    try {
      await fetch(target, { signal: AbortSignal.timeout(3000) })
      return
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(`the gateway never answered at ${redactToken(target)} within ${timeoutMs} ms: ${String(lastError?.message ?? lastError)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/**
 * The RPC envelope's `ok` flag.
 * @param body - the raw response text.
 * @returns `true`/`false` when the body is the JSON envelope, `null` when it is something
 * else (`404 not found` is a legitimate answer and must not be read as a failure by substring).
 */
const rpcOk = (body) => {
  try {
    return JSON.parse(body)?.result?.ok ?? null
  } catch {
    return null
  }
}

/**
 * The one-line wording for the createDirectory reading.
 * @param ok - whether the RPC envelope reported success.
 * @param unavailable - whether the body names the capability refusal.
 * @returns the verdict string.
 */
const createVerdict = (ok, unavailable) => {
  if (ok) return '✅ 可用（browse 后端）'
  return unavailable ? '❌ 不可用（directory-picker/unavailable ⇒ native 后端）' : '❌ 不可用'
}

// A real parent that exists, plus a child name that does not — so the call cannot
// fail for a reason unrelated to the capability.
const parent = mkdtempSync(join(tmpdir(), 'dsh-dirprobe-'))
const childName = `created-${Date.now().toString(36)}`
const childPath = join(parent, childName)

try {
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
    const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-1200))}`)), 120_000)
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
      if (m !== null) { clearTimeout(timer); resolve(m[1]) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
  })
  await waitForGateway(url)

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  // No settle after `goto`: `networkidle` already means the document and its bundles are
  // loaded, and the two calls below are served by the **Host**, whose listener was polled
  // above. The fixed 6 s that used to sit here measured nothing this probe depends on.
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)

  console.log(`profile=${profile}`)
  console.log(`已存在的父目录: ${parent}`)
  console.log(`要创建的子目录: ${childName}`)
  console.log('')

  // `list` is also browse-gated, so it doubles as a second reading of the same
  // question — and it is the verb the in-app browser uses, so its answer tells us
  // which UI the user would have seen.
  console.log('=== directoryPicker/list（同为 browse 门控）===')
  const listed = await rpc('directoryPicker/list', { path: parent })
  console.log(`  HTTP ${String(listed.status)}`)
  console.log(`  ${listed.body.slice(0, 400)}`)
  if (listed.transportError !== undefined) console.log(`  传输失败: ${listed.transportError}`)

  console.log('')
  console.log('=== directoryPicker/createDirectory（browse 门控）===')
  // The gateway insists on exactly one plain-object `args` field, so the two
  // positional parameters are sent by name.
  const created = await rpc('directoryPicker/createDirectory', { path: parent, name: childName })
  console.log(`  HTTP ${String(created.status)}`)
  console.log(`  ${created.body.slice(0, 500)}`)

  // Direct filesystem reading: did anything actually appear? This is the ground
  // truth, independent of what the RPC claimed.
  const appeared = existsSync(childPath)
  console.log('')
  console.log('=== 判定 ===')
  console.log(`  目录是否真的被创建: ${appeared}`)

  const body = created.body
  const unavailable = body.includes('directory-picker/unavailable')
  const ok = rpcOk(body) === true
  if (created.transportError !== undefined) {
    console.log(`  createDirectory 是否可用: ❌ 请求没有得到响应 — ${created.transportError}`)
  } else {
    console.log(`  createDirectory 是否可用: ${createVerdict(ok, unavailable)}`)
  }
  console.log('')
  console.log(`  ⇒ ${ok && appeared
    ? '可以纯客户端建目录：补建方案按设计可行'
    : '不能在客户端建目录：补建方案必须改（见 DESIGN.md 的结论）'}`)

  if (appeared) {
    rmSync(childPath, { recursive: true, force: true })
    console.log(`  （已清理测试目录）`)
  }
} finally {
  if (child !== undefined) child.kill()
  rmSync(parent, { recursive: true, force: true })
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
