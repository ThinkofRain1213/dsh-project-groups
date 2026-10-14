/**
 * `projectGroups/officialDefaultWorkspace` must be provably read-only.
 *
 * ## Why this needs its own probe
 *
 * The settings card warns about a missing default Workspace by asking the Host, and the
 * Host answers by calling `initializeDefault`. That method has **three** branches:
 *
 *   1. its recorded `defaultWorkspaceId` is set → `entities.get(id)` — a pure read;
 *   2. the pointer is unset but the registry/archive set/Session history is non-empty →
 *      `undefined`, before any directory resolution — also a pure read;
 *   3. **everything is empty** → `mkdir` + register a Workspace, and a native Documents
 *      lookup. This is a WRITE.
 *
 * Only branches 1 and 2 may ever run during a probe: rendering a settings page must not
 * create a directory. The Host makes that structural by passing a **throwing** directory
 * resolver, which aborts branch 3 after the branch test and before `mkdir`.
 *
 * This probe demonstrates the guarantee rather than trusting it:
 *
 *   A. the probe on a healthy install answers `present` and changes **nothing**;
 *   B. with the default's registration deleted it answers `missing`, and still changes
 *      nothing — notably it does not recreate the Workspace (which branch 3 would);
 *   C. the probe is safe to repeat, and the registry stays usable afterwards.
 *
 * ## What "changes nothing" means here
 *
 * The official registry file is compared byte-for-byte before and after each call, and the
 * default directory's existence is checked. A write through any path — a new row, a
 * re-pointed pointer, a `mkdir` — shows up in one of those. If that witness cannot be read at
 * all, the probe says so and fails instead of reporting every "unchanged" check as a pass.
 *
 * Usage: node probe-official-default-probe.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-official-default-probe.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a stale process on this port would make the probe talk to the wrong instance, and
// the symptom is a boot that hangs until the 120 s timeout rather than a clear collision.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17890 : 17891))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

let child
let browser
let page

/**
 * Boot the Host and resolve the tokenised dev-server URL.
 *
 * A function, not top-level code, so the boot path runs inside the try/finally below: a boot
 * timeout used to reject before the guarded region was entered, so neither the spawned Host nor
 * the browser was ever cleaned up.
 *
 * The URL is not treated as "the server is ready": stdout printing it happens before the client
 * bundles finish serving, so the server is polled until it answers. The old shape waited a flat
 * 3 s, which on a slow machine turned into a `goto` failure rather than a clear statement.
 */
const boot = async () => {
  child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  // `out` only has to hold enough context for a failure message; once the URL is matched the
  // listeners stop appending to it, instead of growing the buffer for the rest of the run.
  let matched = false
  const url = await new Promise((resolve, reject) => {
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
      if (matched) return
      out += String(chunk)
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (m !== null) { matched = true; clearTimeout(timer); resolve(m[1]) }
    })
    child.stderr.on('data', (chunk) => { if (!matched) out += chunk })
  })

  const ready = await waitForServer(url)
  if (!ready) console.log('  (警告: 在 30s 内没有等到 dev server 应答，继续尝试加载页面)')
  return url
}

/** Poll the dev server until it answers, instead of assuming a fixed settle time is enough. */
const waitForServer = async (target, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(target, { method: 'GET' })
      if (response.status < 500) {
        // Drain the body so the socket is not left open.
        await response.arrayBuffer()
        return true
      }
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/**
 * One RPC round trip.
 *
 * The status is checked and `JSON.parse` guarded: a non-JSON error page or a truncated body used
 * to throw from inside `page.evaluate`, which surfaced as an unhandled rejection instead of as a
 * recorded FAIL.
 */
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
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch { /* reported through `status`/`body` */ }
  return {
    status: response.status,
    ok: response.status === 200 ? parsed?.result?.ok : false,
    value: parsed?.result?.value,
    error: parsed?.result?.error ?? (parsed === null ? `non-JSON response (status ${String(response.status)})` : null),
    body: text.slice(0, 200),
  }
}, { method, args })

const registryFile = join(dshHome, 'storages', 'workspace.json')
/**
 * The registry file's exact bytes, as the "did anything change" witness.
 *
 * `null` means "could not be read". It must not be compared as if it were content: two `null`s
 * are equal, so an unreadable registry used to make every "unchanged" check pass without
 * witnessing anything.
 */
const registryBytes = () => {
  try { return readFileSync(registryFile, 'utf8') } catch { return null }
}
/** One snapshot, so a comparison and its diagnostic cannot come from two different reads. */
const registryState = () => {
  let raw
  try {
    raw = readFileSync(registryFile, 'utf8')
  } catch { return null }
  try {
    const parsed = JSON.parse(raw)
    return {
      defaultWorkspaceId: parsed.global?.defaultWorkspaceId ?? null,
      ids: parsed.global?.workspaceIds ?? [],
      rows: Object.entries(parsed.tables?.workspaces ?? {}).map(([id, row]) => ({ id, path: row.path })),
    }
  } catch {
    return null
  }
}

try {
  const url = await boot()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)

  console.log('=== A. 健康安装：探测答 present 且不改动任何东西 ===')
  const beforeHealthy = registryBytes()
  const healthyState = registryState()
  // The witness itself is asserted first: without it, every "unchanged" check below is vacuous.
  check('A) 官方注册表可读（"未改动"的见证）',
    beforeHealthy !== null && healthyState !== null, String(registryFile))
  const healthyDefault = (await rpc('workspace/initializeDefault', {})).value?.workspace ?? null
  check('A) 起点有官方默认工作区', healthyDefault !== null, JSON.stringify(healthyDefault))
  if (healthyDefault === null || beforeHealthy === null || healthyState === null) {
    // Both branches below dereference this workspace, and with an empty `defaultPath` the
    // directory-existence checks would compare `false === false` and pass for the wrong reason.
    throw new Error('A) 的前提不成立（没有可读的注册表，或没有官方默认工作区）；B/C 的结论将无从谈起')
  }
  const defaultPath = healthyDefault.path ?? ''
  check('A) 默认工作区带 path', defaultPath !== '', JSON.stringify(healthyDefault))
  const existsBefore = defaultPath === '' ? null : existsSync(defaultPath)

  const probeHealthy = await rpc('projectGroups/officialDefaultWorkspace', {})
  console.log(`  探测: ${JSON.stringify(probeHealthy.value ?? null)}`)
  check('A) 探测成功', probeHealthy.ok === true, JSON.stringify(probeHealthy.error ?? null))
  check('A) 答 present', probeHealthy.value?.status === 'present', JSON.stringify(probeHealthy.value))
  check('A) 带回 workspaceId', typeof probeHealthy.value?.workspaceId === 'string',
    String(probeHealthy.value?.workspaceId))
  check('A) 带回路径', probeHealthy.value?.path === defaultPath,
    `${String(probeHealthy.value?.path)} vs ${defaultPath}`)
  check('A) 注册表字节未变', registryBytes() === beforeHealthy)
  const stateAfterHealthy = registryState()
  check('A) 注册表状态未变',
    JSON.stringify(stateAfterHealthy) === JSON.stringify(healthyState),
    JSON.stringify(stateAfterHealthy))
  check('A) 目录存在性未变',
    existsBefore !== null && existsSync(defaultPath) === existsBefore,
    String(existsBefore))

  console.log('')
  console.log('=== B. 删掉注册（复现缺失）：探测答 missing，且【不重建】===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: healthyDefault.workspaceId } })
  check('B) 删除成功', deleted.status === 200 && deleted.value?.deleted === true,
    `status=${String(deleted.status)} value=${JSON.stringify(deleted.value)} error=${JSON.stringify(deleted.error)}`)
  const afterDeleteBytes = registryBytes()
  const afterDeleteState = registryState()
  console.log(`  删后 defaultWorkspaceId=${String(afterDeleteState?.defaultWorkspaceId)}（残留的悬空指针）`)
  check('B) 删后注册表仍可读（"未改动"的见证）',
    afterDeleteBytes !== null && afterDeleteState !== null, String(registryFile))

  const probeMissing = await rpc('projectGroups/officialDefaultWorkspace', {})
  console.log(`  探测: ${JSON.stringify(probeMissing.value ?? null)}`)
  check('B) 答 missing', probeMissing.value?.status === 'missing', JSON.stringify(probeMissing.value))
  // THE guarantee: branch 3 of `initializeDefault` is what creates the Workspace, and the
  // probe passes a throwing resolver so it can never reach `mkdir`.
  const stateAfterMissing = registryState()
  check('B) 没有冒出一行新注册',
    stateAfterMissing !== null && JSON.stringify(stateAfterMissing) === JSON.stringify(afterDeleteState),
    JSON.stringify(stateAfterMissing?.rows))
  check('B) 注册表字节未变',
    afterDeleteBytes !== null && registryBytes() === afterDeleteBytes)
  check('B) 指针没有被改写',
    stateAfterMissing !== null && stateAfterMissing.defaultWorkspaceId === afterDeleteState?.defaultWorkspaceId,
    JSON.stringify(stateAfterMissing?.defaultWorkspaceId))
  check('B) 目录没有被重新创建（探测不是写路径）',
    existsBefore !== null && existsSync(defaultPath) === existsBefore)

  console.log('')
  console.log('=== C. 可重复，且不影响后续写操作 ===')
  const again = await rpc('projectGroups/officialDefaultWorkspace', {})
  check('C) 再探一次仍是 missing', again.value?.status === 'missing', JSON.stringify(again.value))
  check('C) 两次探测结果一致',
    JSON.stringify(again.value) === JSON.stringify(probeMissing.value))
  // A rejection inside the registry's mutation queue must not poison it. If it did, this
  // write would hang or fail.
  const created = await rpc('projectGroups/create', { request: { title: 'probe-queue-alive' } })
  check('C) 队列仍可用（探测的拒绝没有毒化它）', created.ok === true,
    JSON.stringify(created.error ?? created.value ?? null))
  const baseline = await rpc('projectGroups/baseline', {})
  const titles = (baseline.value?.projects ?? []).map(project => project.title)
  check('C) 项目确实写进去了', titles.includes('probe-queue-alive'), JSON.stringify(titles))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} catch (error) {
  // The premise guards above abort branches A/B; recorded as a failure so the summary and the
  // exit code are still produced instead of a raw stack trace.
  check('探针的前提成立并跑完', false, String(error?.message ?? error))
} finally {
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
process.exit(failures.length === 0 ? 0 : 1)
