/**
 * Step ③ feasibility, measured: does the flow actually work end to end?
 *
 * The plan is: Host `mkdir` → `ctx.workspaceRegistry.create(path, title)` → the Client sees the
 * new row → the navigation resolves it. Reading the code says yes, but three things could each
 * break it and none is answerable from a grep:
 *
 *   1. `realpathNormalize` rejects a path that is not **fully qualified**, and on Windows it
 *      rejects a bare root (`\`). A path that survives mkdir must also survive this.
 *   2. `workspace/create` resolves an existing Workspace by path first, so a rebuild over an
 *      already-registered path should be idempotent rather than a duplicate.
 *   3. The rebuild button's whole purpose is the **case where the Workspace is gone** — so the
 *      path is typically absent from the registry but its *parent* normally exists. If the
 *      parent is also gone, `recursive: true` is what lets mkdir succeed; without it, ENOENT.
 *
 * This creates a throwaway Workspace through the **live** Host the same way ③ will, deletes the
 * registration, re-creates the directory and re-registers, and reports what each step returned.
 * It also confirms the two refusal shapes so the plan can state them.
 *
 * Usage: node probe-rebuild-feasibility.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-rebuild-feasibility.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a leftover Host from an aborted run holds the fixed port, and the next probe
// then reports a boot timeout for what is really an occupied port.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17980 : 17981))
// `join`, not a `\\`-joined literal: on a POSIX runner a backslash is an ordinary filename
// character, so the literal path silently never resolves. (Also tolerates an `asarRoot` that
// already ends in a separator, which the literal produced as `...\\\dsh`.)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  // Collected, and turned into an exit code at the end. Without this the probe printed FAIL lines
  // and still exited 0, so a run that failed every step looked exactly like a passing one to CI.
  if (!ok) failures.push(label)
}

let child
let browser
let page

/**
 * One `/api` RPC.
 *
 * The transport failures and the Host's refusals are kept apart. `page.evaluate` rejects on a
 * network error or a timeout, and the old deep optional chaining then collapsed an unexpected
 * envelope to `ok=undefined` — so "the request never arrived" and "the Host refused" produced the
 * same output. A parse failure is likewise reported rather than swallowed by an empty `catch`.
 * @param method - the RPC to call.
 * @param args - its `payload.args`.
 * @returns `{ status, ok, value, error, text, problem }`, with `problem` set for a transport or
 * parse failure.
 */
const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  let response
  let text
  try {
    response = await fetch(`${location.origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request', rpcId: `p-${Math.random().toString(36).slice(2)}`,
        method, payload: { args },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    text = await response.text()
  } catch (error) {
    return { status: null, ok: undefined, value: undefined, error: undefined, text: '', problem: `${method}: transport failed — ${error.message}` }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { status: response.status, ok: undefined, value: undefined, error: undefined, text: text.slice(0, 260), problem: `${method}: non-JSON response (${error.message})` }
  }
  return { status: response.status, ok: parsed?.result?.ok, value: parsed?.result?.value, error: parsed?.result?.error, text: text.slice(0, 260), problem: undefined }
}, { method, args })

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

const scratchRoot = join(dshHome, 'rebuild-probe')
const target = join(scratchRoot, 'nested', 'child')

try {
  // Spawned inside the `try` so the `finally` always reaches `child.kill()`. While this sat above
  // the `try`, a boot timeout — or any throw out of `chromium.launch` — rejected the top-level
  // await before cleanup ran and left the Host running on the port.
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

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 1. 目录不存在时，workspace/create 应拒绝（证实"先 mkdir"的顺序）===')
  if (existsSync(scratchRoot)) rmSync(scratchRoot, { recursive: true, force: true })
  const absent = await rpc('workspace/create', { request: { path: target } })
  console.log(`  status=${String(absent.status)}  ok=${String(absent.ok)}  error=${JSON.stringify(absent.error?.code ?? null)}`)
  console.log(`  ${absent.text.slice(0, 180)}`)
  // `status === 200` is required: this check asserts a *refusal*, and a transport failure also
  // leaves `ok !== true` — so without it "the request never arrived" would read as "the Host
  // correctly refused".
  check('1) 目录不存在时被拒绝', absent.status === 200 && absent.ok !== true, absent.problem ?? '')

  console.log('')
  console.log('=== 2. 只建父目录（不建叶子）仍应被拒绝 ===')
  mkdirSync(scratchRoot, { recursive: true })
  const parentOnly = await rpc('workspace/create', { request: { path: target } })
  check('2) 只建父目录仍被拒绝',
    parentOnly.status === 200 && parentOnly.ok !== true,
    parentOnly.problem ?? JSON.stringify(parentOnly.error?.code ?? null))

  console.log('')
  console.log('=== 3. mkdir -p（recursive）后再 create 应成功 ===')
  mkdirSync(target, { recursive: true })
  const created = await rpc('workspace/create', { request: { path: target } })
  const createdId = created.value?.workspace?.workspaceId ?? null
  console.log(`  ok=${String(created.ok)}  id=${String(createdId)}`)
  check('3) 建目录后注册成功', created.ok === true && createdId !== null)

  console.log('')
  console.log('=== 4. 对同一路径再 create 应幂等（不产生重复行）===')
  const again = await rpc('workspace/create', { request: { path: target } })
  const againId = again.value?.workspace?.workspaceId ?? null
  console.log(`  ok=${String(again.ok)}  id=${String(againId)}  created=${String(again.value?.created)}`)
  check('4) 幂等：同一个 id', againId === createdId, `${String(createdId)} vs ${String(againId)}`)
  check('4) 明确报告未新建（created=false）', again.value?.created === false, JSON.stringify(again.value?.created))

  console.log('')
  console.log('=== 5. 删除注册后：目录还在，重新 create 应重新认领同一目录 ===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: createdId } })
  check('5) 删除注册成功', deleted.ok === true)
  check('5) 目录仍在磁盘上', existsSync(target))
  const readopted = await rpc('workspace/create', { request: { path: target } })
  const readoptId = readopted.value?.workspace?.workspaceId ?? null
  console.log(`  重新注册 id=${String(readoptId)}（新 id 是预期的，见 spec.ts 的说明）`)
  check('5) 重新注册成功', readopted.ok === true && readoptId !== null)
  check('5) 拿到的是新 id（证明"只存 path 不存 id"是对的）', readoptId !== createdId,
    `${String(createdId)} vs ${String(readoptId)}`)

  console.log('')
  console.log('=== 6. 注册表里最终只有一条该路径 ===')
  // Unguarded before: `readFileSync` + `JSON.parse` + `Object.values(registry.tables.workspaces)`
  // assumed the file existed with that exact shape, so a missing or newer `workspace.json` threw
  // an opaque `TypeError`/`ENOENT` with no diagnostic about the registry it was reading.
  const registryFile = join(dshHome, 'storages', 'workspace.json')
  let paths = null
  if (!existsSync(registryFile)) {
    console.log(`  ${registryFile} 不存在 —— 无法核对注册表`)
  } else {
    try {
      const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
      paths = Object.values(registry?.tables?.workspaces ?? {}).map(row => row?.path)
    } catch (error) {
      console.log(`  ${registryFile} 无法解析 —— ${error.message}`)
    }
  }
  const matches = paths === null ? null : paths.filter(p => p === target).length
  console.log(`  该路径的条数: ${String(matches)}（全部路径: ${JSON.stringify(paths)}）`)
  check('6) 只有一条', matches === 1, `${String(matches)} 条`)
} finally {
  if (child !== undefined) child.kill() // guarded: a synchronous `spawn` throw leaves it unset
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
  rmSync(scratchRoot, { recursive: true, force: true })
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
