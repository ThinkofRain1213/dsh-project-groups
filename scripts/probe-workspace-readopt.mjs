/**
 * When a Workspace registration is deleted and then re-created at the same path,
 * does the registry re-adopt the Sessions that live there?
 *
 * This decides the user's open design question. Their specified Workspace can be
 * deleted from the official sidebar, and the plugin then has to choose what its
 * settings row shows and what the New Session dialog offers:
 *
 *   A. show "未指定工作区" and send the user to settings to re-pick;
 *   B. keep showing the stored Workspace and offer "确认新建".
 *
 * B is only defensible if re-creating the registration is **lossless** — i.e. the
 * Sessions whose `cwd` is inside that path come back under it, rather than the new
 * registration starting empty and leaving them orphaned (which would make B silently
 * worse than re-picking). The registry carries a canonical-cwd header index and a
 * `sessionPaths` map, so re-adoption is plausible; it is measured, not assumed.
 *
 * Sequence: create the default Workspace, put a Session in it, delete the
 * registration (files kept, by design), re-create it at the same path, and compare
 * the Session set before and after.
 *
 * Nothing is deleted from disk: `workspace/delete` retains files and Sessions.
 *
 * Usage: node probe-workspace-readopt.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-workspace-readopt.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17820 : 17821
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
  } catch { /* raw text is printed on failure */ }
  return { status: response.status, text, value: parsed?.result?.value, ok: parsed?.result?.ok, error: parsed?.result?.error }
}, { method, args })

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 8; i += 1) {
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

/** The Host's session list, normalised. */
const hostSessions = () => page.evaluate(async () => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `probe-${Math.random().toString(36).slice(2)}`,
      method: 'session/list',
      payload: { args: { _request: {} } },
    }),
  })
  const body = await response.json()
  const items = body?.result?.value?.sessions ?? body?.result?.value?.items ?? []
  return (Array.isArray(items) ? items : []).map(item => ({
    id: item.sessionId,
    cwd: item.cwd,
    blank: item.blank,
    title: item.projections?.values?.title ?? null,
  }))
})

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 1. 取得默认工作区 ===')
  const first = await rpc('workspace/initializeDefault', {})
  const workspace = first.value?.workspace ?? null
  if (workspace === null) throw new Error(`no default workspace: ${first.text.slice(0, 200)}`)
  const path = workspace.path
  const firstId = workspace.workspaceId
  console.log(`  id=${firstId}`)
  console.log(`  path=${path}`)
  console.log(`  初始 sessionIds=${JSON.stringify(workspace.sessionIds)}`)

  console.log('')
  console.log('=== 2. 在里面建一个真实会话（发一条消息）===')
  await page.locator('button[aria-label="新建项目"]').first().click().catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(500)

  // Use the shell's own New Session control, so the Session lands in the default
  // Workspace through the normal path.
  const newSession = page.getByRole('button', { name: /新建会话|新会话/ }).first()
  await newSession.click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  const composer = page.locator('[contenteditable="true"], textarea').first()
  await composer.click({ force: true })
  await composer.type('readopt-test', { delay: 40 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(9000)
  await dismiss()

  const sessionsBefore = await hostSessions()
  const seeded = sessionsBefore.find(item => item.title === 'readopt-test') ?? null
  console.log(`  Host 会话数: ${sessionsBefore.length}`)
  console.log(`  种下的会话: ${JSON.stringify(seeded)}`)

  const beforeView = await rpc('workspace/initializeDefault', {})
  const beforeWorkspace = beforeView.value?.workspace ?? null
  console.log(`  工作区 sessionIds（删前）: ${JSON.stringify(beforeWorkspace?.sessionIds)}`)

  console.log('')
  console.log('=== 3. 删除该工作区的注册（保留目录与会话）===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: firstId } })
  console.log(`  ok=${String(deleted.ok)}  ${deleted.text.slice(0, 120)}`)

  const afterDelete = await hostSessions()
  console.log(`  删除后 Host 会话数: ${afterDelete.length}`)
  console.log(`  种下的会话是否还在: ${afterDelete.some(item => item.id === seeded?.id)}`)
  const afterDeleteView = await rpc('workspace/initializeDefault', {})
  console.log(`  initializeDefault 现在返回: ${JSON.stringify(afterDeleteView.value ?? null)}`)

  console.log('')
  console.log('=== 4. 用同一 path 重新注册 ===')
  const recreated = await rpc('workspace/create', { request: { path } })
  const newWorkspace = recreated.value?.workspace ?? null
  console.log(`  ok=${String(recreated.ok)}  created=${String(recreated.value?.created)}`)
  console.log(`  新 id=${String(newWorkspace?.workspaceId)}  与原 id 相同: ${newWorkspace?.workspaceId === firstId}`)
  console.log(`  新注册的 sessionIds=${JSON.stringify(newWorkspace?.sessionIds)}`)

  console.log('')
  console.log('=== 5. 结论 ===')
  const adoptedImmediately = Array.isArray(newWorkspace?.sessionIds) && seeded !== null
    && newWorkspace.sessionIds.includes(seeded.id)
  console.log(`  重新注册后【立即】是否收回原会话: ${adoptedImmediately ? '✅ 是' : '❌ 否（新注册 sessionIds 为空）'}`)
  console.log('')

  // The registry builds a canonical-cwd header index at startup and "completes the
  // one-time history bootstrap before the service becomes active", so re-adoption may
  // happen on the *next boot* rather than at registration time. That distinction is
  // the whole answer: if a restart adopts them, a re-created Workspace is lossless in
  // the end and the stored-path design is safe; if it never adopts them, re-creating
  // orphans the Sessions permanently.
  console.log('=== 6. 重启后再看（cwd 索引在启动时重建）===')
  running.kill()
  await page.waitForTimeout(2500)

  const restarted = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT + 1), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out2 = ''
  const url2 = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`restart boot timeout:\n${out2.slice(-1200)}`)), 120_000)
    restarted.stdout.on('data', (chunk) => {
      out2 += String(chunk)
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out2)
      if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
    })
    restarted.stderr.on('data', (chunk) => { out2 += chunk })
  })
  running = restarted

  await page.goto(url2, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(9000)
  await dismiss()

  const afterRestart = await rpc('workspace/initializeDefault', {})
  const restartWorkspace = afterRestart.value?.workspace ?? null
  console.log(`  initializeDefault 返回: ${restartWorkspace === null ? 'null' : `id=${String(restartWorkspace.workspaceId)}`}`)

  // `initializeDefault` returns null once the pointer is dead, so read the registry
  // through the client's own workspace list instead — that is what the sidebar shows.
  const listed = await page.evaluate(async () => {
    const token = new URL(location.href).searchParams.get('token') ?? ''
    const response = await fetch(`${location.origin}/api/workspace/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({ type: 'client-request', rpcId: 'l', method: 'workspace/list', payload: { args: {} } }),
    })
    return (await response.text()).slice(0, 300)
  })
  console.log(`  workspace/list: ${listed}`)

  // The sidebar rows are the user-visible truth about which Workspace owns what.
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-row-key]')]
    .map(node => ({
      key: node.getAttribute('data-row-key'),
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
    })))
  console.log(`  侧栏行: ${JSON.stringify(rows)}`)

  const sessionsAfterRestart = await hostSessions()
  console.log(`  Host 会话数: ${sessionsAfterRestart.length}`)
  console.log(`  种下的会话仍在: ${sessionsAfterRestart.some(item => item.id === seeded?.id)}`)

  console.log('')
  console.log('=== 最终判定 ===')
  console.log(`  注册时立即收回: ${adoptedImmediately ? '是' : '否'}`)
  const sessionRowPresent = rows.some(row => row.key === `session:${String(seeded?.id)}@` || row.key.includes(String(seeded?.id)))
  console.log(`  重启后该会话仍渲染在侧栏: ${sessionRowPresent}`)
} finally {
  running.kill()
  await browser.close()
}
