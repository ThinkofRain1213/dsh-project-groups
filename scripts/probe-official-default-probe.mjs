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
 * re-pointed pointer, a `mkdir` — shows up in one of those.
 *
 * Usage: node probe-official-default-probe.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-official-default-probe.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17890 : 17891
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
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

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
  return { ok: parsed?.result?.ok, value: parsed?.result?.value, error: parsed?.result?.error }
}, { method, args })

const registryFile = `${dshHome}/storages/workspace.json`
/** The registry file's exact bytes, as the "did anything change" witness. */
const registryBytes = () => {
  try { return readFileSync(registryFile, 'utf8') } catch { return null }
}
const registryState = () => {
  try {
    const parsed = JSON.parse(readFileSync(registryFile, 'utf8'))
    return {
      defaultWorkspaceId: parsed.global?.defaultWorkspaceId ?? null,
      ids: parsed.global?.workspaceIds ?? [],
      rows: Object.entries(parsed.tables?.workspaces ?? {}).map(([id, row]) => ({ id, path: row.path })),
    }
  } catch {
    return null
  }
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)

  console.log('=== A. 健康安装：探测答 present 且不改动任何东西 ===')
  const beforeHealthy = registryBytes()
  const healthyState = registryState()
  const healthyDefault = (await rpc('workspace/initializeDefault', {})).value?.workspace ?? null
  check('A) 起点有官方默认工作区', healthyDefault !== null, JSON.stringify(healthyDefault))
  const defaultPath = healthyDefault?.path ?? ''
  const existsBefore = existsSync(defaultPath)

  const probeHealthy = await rpc('projectGroups/officialDefaultWorkspace', {})
  console.log(`  探测: ${JSON.stringify(probeHealthy.value ?? null)}`)
  check('A) 探测成功', probeHealthy.ok === true, JSON.stringify(probeHealthy.error ?? null))
  check('A) 答 present', probeHealthy.value?.status === 'present', JSON.stringify(probeHealthy.value))
  check('A) 带回 workspaceId', typeof probeHealthy.value?.workspaceId === 'string',
    String(probeHealthy.value?.workspaceId))
  check('A) 带回路径', probeHealthy.value?.path === defaultPath,
    `${String(probeHealthy.value?.path)} vs ${defaultPath}`)
  check('A) 注册表字节未变', registryBytes() === beforeHealthy)
  check('A) 注册表状态未变',
    JSON.stringify(registryState()) === JSON.stringify(healthyState),
    JSON.stringify(registryState()))
  check('A) 目录存在性未变', existsSync(defaultPath) === existsBefore)

  console.log('')
  console.log('=== B. 删掉注册（复现缺失）：探测答 missing，且【不重建】===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: healthyDefault.workspaceId } })
  check('B) 删除成功', deleted.value?.deleted === true)
  const afterDeleteBytes = registryBytes()
  const afterDeleteState = registryState()
  console.log(`  删后 defaultWorkspaceId=${String(afterDeleteState?.defaultWorkspaceId)}（残留的悬空指针）`)

  const probeMissing = await rpc('projectGroups/officialDefaultWorkspace', {})
  console.log(`  探测: ${JSON.stringify(probeMissing.value ?? null)}`)
  check('B) 答 missing', probeMissing.value?.status === 'missing', JSON.stringify(probeMissing.value))
  // THE guarantee: branch 3 of `initializeDefault` is what creates the Workspace, and the
  // probe passes a throwing resolver so it can never reach `mkdir`.
  check('B) 没有冒出一行新注册',
    JSON.stringify(registryState()) === JSON.stringify(afterDeleteState),
    JSON.stringify(registryState()?.rows))
  check('B) 注册表字节未变', registryBytes() === afterDeleteBytes)
  check('B) 指针没有被改写', registryState()?.defaultWorkspaceId === afterDeleteState?.defaultWorkspaceId)
  check('B) 目录没有被重新创建（探测不是写路径）', existsSync(defaultPath) === existsBefore)

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
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
