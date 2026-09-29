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
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-directory-create-availability.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17770 : 17771
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

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
  child.stderr.on('data', (chunk) => { out += chunk })
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))

/**
 * Call one RPC method over the same wire the client uses.
 *
 * The path is `/api/<full method>` — the namespace is part of the method name
 * (`directoryPicker/list`), not a separate path segment. Getting that wrong returns
 * a bare `404 not found`, which is indistinguishable from a real refusal unless
 * something checks for it; hence the status and raw body are both printed.
 * @param method - full method name, e.g. `directoryPicker/list`.
 * @param args - named parameters of the remote method.
 * @returns the parsed response.
 */
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
  return { status: response.status, body: await response.text() }
}, { method, args })

// A real parent that exists, plus a child name that does not — so the call cannot
// fail for a reason unrelated to the capability.
const parent = mkdtempSync(join(tmpdir(), 'dsh-dirprobe-'))
const childName = `created-${Date.now().toString(36)}`
const childPath = join(parent, childName)

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6000)

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
  const ok = body.includes('"ok":true')
  console.log(`  createDirectory 是否可用: ${ok ? '✅ 可用（browse 后端）' : `❌ 不可用${unavailable ? '（directory-picker/unavailable ⇒ native 后端）' : ''}`}`)
  console.log('')
  console.log(`  ⇒ ${ok && appeared
    ? '可以纯客户端建目录：补建方案按设计可行'
    : '不能在客户端建目录：补建方案必须改（见 DESIGN.md 的结论）'}`)

  if (appeared) {
    rmSync(childPath, { recursive: true, force: true })
    console.log(`  （已清理测试目录）`)
  }
} finally {
  running.kill()
  rmSync(parent, { recursive: true, force: true })
  await browser.close()
}
