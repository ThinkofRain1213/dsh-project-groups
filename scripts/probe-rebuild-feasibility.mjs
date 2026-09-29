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
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-rebuild-feasibility.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17980 : 17981
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
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
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* raw */ }
  return { ok: parsed?.result?.ok, value: parsed?.result?.value, error: parsed?.result?.error, text: text.slice(0, 260) }
}, { method, args })

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 6; i += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Later']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        await button.click({ force: true }).catch(() => {})
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(700)
  }
}

const scratchRoot = join(dshHome, 'rebuild-probe')
const target = join(scratchRoot, 'nested', 'child')

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 1. 目录不存在时，workspace/create 应拒绝（证实"先 mkdir"的顺序）===')
  if (existsSync(scratchRoot)) rmSync(scratchRoot, { recursive: true, force: true })
  const absent = await rpc('workspace/create', { request: { path: target } })
  console.log(`  ok=${String(absent.ok)}  error=${JSON.stringify(absent.error?.code ?? null)}`)
  console.log(`  ${absent.text.slice(0, 180)}`)
  check('1) 目录不存在时被拒绝', absent.ok !== true)

  console.log('')
  console.log('=== 2. 只建父目录（不建叶子）仍应被拒绝 ===')
  mkdirSync(scratchRoot, { recursive: true })
  const parentOnly = await rpc('workspace/create', { request: { path: target } })
  check('2) 只建父目录仍被拒绝', parentOnly.ok !== true, JSON.stringify(parentOnly.error?.code ?? null))

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
  const registry = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
  const paths = Object.values(registry.tables.workspaces).map(row => row.path)
  const matches = paths.filter(p => p === target).length
  console.log(`  该路径的条数: ${String(matches)}（全部路径: ${JSON.stringify(paths)}）`)
  check('6) 只有一条', matches === 1, `${String(matches)} 条`)
} finally {
  running.kill()
  await browser.close()
  rmSync(scratchRoot, { recursive: true, force: true })
}
