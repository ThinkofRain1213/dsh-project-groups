/**
 * Step 3b, the one case that decides 3b's scope: does rebuilding fix the `default` mode too?
 *
 * The dialog has two shapes. `'specified'` is the user's own pick (the reported case: `apk` is
 * gone) and rebuilding is a plain mkdir + register — `resolveBaseWorkspace` then finds it by path
 * and the click works.
 *
 * `'default'` is the official first-use Workspace. Earlier measurement (`probe-initialize-default-
 * after-delete`) found that after `workspace/delete`, `initializeDefault` returns nothing and
 * **re-registering the same path mints a new id that it does not re-adopt**. If that still holds,
 * a rebuild in `'default'` mode would create the directory, register it, and leave the very same
 * failure in place — the dialog would reappear on the next click. That would make 3b a lie for one
 * of its two buttons, so it has to be settled before writing any code.
 *
 * Method: delete the default's registration, recreate the directory and register it (what 3b would
 * do), then ask `initializeDefault` again and report whether it resolves.
 *
 * Usage: node probe-rebuild-default-mode.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-rebuild-default-mode.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17975 : 17976
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

const registryState = () => {
  try {
    const parsed = JSON.parse(readFileSync(`${dshHome}/storages/workspace.json`, 'utf8'))
    const global = parsed.global ?? {}
    return {
      defaultWorkspaceId: global.defaultWorkspaceId ?? null,
      rows: Object.entries(parsed.tables?.workspaces ?? {})
        .map(([id, row]) => ({ id, path: row.path })),
    }
  } catch {
    return null
  }
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)

  console.log('=== 1. 起点：默认工作区 ===')
  const first = await rpc('workspace/initializeDefault', {})
  const workspace = first.value?.workspace ?? null
  console.log(`  ${JSON.stringify(workspace === null ? null : { id: workspace.workspaceId, path: workspace.path })}`)
  const before = registryState()
  console.log(`  defaultWorkspaceId=${String(before?.defaultWorkspaceId)}`)
  check('拿到默认工作区', workspace !== null)

  console.log('')
  console.log('=== 2. 删除它的注册（模拟用户误删）===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: workspace.workspaceId } })
  check('删除成功', deleted.value?.deleted === true)
  const afterDelete = await rpc('workspace/initializeDefault', {})
  console.log(`  删除后 initializeDefault: ${JSON.stringify(afterDelete.value ?? null)}`)
  check('删除后不再解析（复现缺失）', (afterDelete.value?.workspace ?? null) === null,
    JSON.stringify(afterDelete.value?.workspace ?? null))

  console.log('')
  console.log('=== 3. 模拟 3b：目录重建 + 按同路径重新注册 ===')
  // The directory itself may still exist (deleting a registration keeps files); 3b would mkdir it
  // anyway, which is idempotent.
  mkdirSync(workspace.path, { recursive: true })
  check('目录存在', existsSync(workspace.path))
  const recreated = await rpc('workspace/create', { request: { path: workspace.path } })
  const newId = recreated.value?.workspace?.workspaceId ?? null
  console.log(`  重新注册: id=${String(newId)}  created=${String(recreated.value?.created)}`)
  check('重新注册成功', newId !== null)
  const afterRebuild = registryState()
  console.log(`  defaultWorkspaceId=${String(afterRebuild?.defaultWorkspaceId)}  新 id=${String(newId)}`)
  check('新注册的 id 与 defaultWorkspaceId 不同（重注册换 id）',
    newId !== before?.defaultWorkspaceId,
    `${String(before?.defaultWorkspaceId)} vs ${String(newId)}`)

  console.log('')
  console.log('=== 4. 关键：重建后 initializeDefault 能解析了吗？（决定 3b 能否修 default 模式）===')
  const afterRebuildInit = await rpc('workspace/initializeDefault', {})
  const resolved = afterRebuildInit.value?.workspace ?? null
  console.log(`  ${JSON.stringify(resolved === null ? null : { id: resolved.workspaceId, path: resolved.path })}`)
  const stillBroken = resolved === null
  console.log('')
  console.log('=== 判读 ===')
  if (stillBroken) {
    console.log('  ⇒ 重建【修不好】default 模式：defaultWorkspaceId 仍指向已删的记录，')
    console.log('     重新注册给出的是新 id，initializeDefault 不重新采纳。')
    console.log('     ⇒ 3b 的「重建」只对 specified 模式成立；default 模式需要另想办法。')
  } else {
    console.log('  ⇒ 重建后 initializeDefault 恢复解析 ⇒ 3b 对两种模式都成立。')
  }
  check('（记录事实）重建后 initializeDefault 是否恢复', true,
    stillBroken ? '仍然解析不到' : '恢复解析')

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
  rmSync(`${dshHome}/rebuild-probe`, { recursive: true, force: true })
}
process.exit(failures.length === 0 ? 0 : 1)
