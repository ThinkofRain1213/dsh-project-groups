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
 *
 * ## What this run leaves behind
 *
 * One Session (titled per run, see {@link SEEDED_TITLE}) and the re-created default
 * Workspace registration. Neither is cleaned up, and that is deliberate: the Remote surface
 * has no session delete verb (the session controller exposes `list`/`create`/`rename`/
 * `fork`/`prompt`/`cancel`/… but nothing that removes one), and deleting the Workspace this
 * probe just re-created would destroy the very state it exists to measure. What IS handled is
 * cross-run interference: the title carries a per-run stamp, so a leftover Session from an
 * earlier run cannot be mistaken for this run's seed — which is what a fixed
 * `readopt-test` title did, since the lookup is by title.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-workspace-readopt.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// `join` + an overridable port: the escaped-backslash path cannot resolve off Windows, and
// the fixed port collided with a parallel probe or a stale server still holding it.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17820 : 17821))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/**
 * The seeded Session's title (its first message), unique per run.
 *
 * A fixed title made a re-run against the same profile ambiguous: the lookup is by title, so
 * a Session left by an earlier run could be picked as this run's seed and the verdict would
 * describe the wrong Session.
 */
const SEEDED_TITLE = `readopt-test-${Date.now().toString(36)}`

/**
 * UI copy this probe matches on, in one place.
 *
 * Localized labels are what an installed bundle exposes; when a wording changes, this is the
 * one line to update rather than a string buried in the driver.
 */
const NEW_SESSION_LABELS = /新建会话|新会话/

// 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
// 进程存活但从不监听端口 —— 那时下面这行 spawn 等到的只是一条误导性的超时。
const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile })
if (prepared.problem !== undefined) {
  console.error(`无法准备探针环境：${prepared.problem}`)
  process.exit(2)
}
const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

/**
 * Boot one Host child and wait for the URL it prints.
 *
 * Extracted because this file boots **twice**, and the restart copy had no handlers at all:
 * a failed spawn (bad `exe`/`BIN`) emits `'error'` with no listener, which crashes the probe
 * outright, and a process that dies before printing its URL left the promise pending for the
 * full 120 s instead of failing fast with the reason. The timer is cleared on every path.
 * @param process_ - the spawned child.
 * @param label - which boot this is, for the timeout/exit message.
 * @returns the authenticated dev-server URL.
 */
const boot = (process_, label) => new Promise((resolve, reject) => {
  let out = ''
  const timer = setTimeout(() => reject(new Error(`${label} timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
  process_.once('error', (error) => {
    clearTimeout(timer)
    reject(new Error(`${label} spawn failed for ${exe}: ${String(error?.message ?? error)}`))
  })
  process_.once('exit', (code, signal) => {
    clearTimeout(timer)
    reject(new Error(`${label}: Host exited before printing its URL (code ${String(code)}, signal ${String(signal)}):\n${redactToken(out.slice(-1500))}`))
  })
  process_.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  process_.stderr.on('data', (chunk) => { out += chunk })
})

let browser
let page

/**
 * The one in-page request envelope, installed on every document.
 *
 * Three copies of "read the token, POST the `client-request` envelope, unwrap `result`" used
 * to exist here — {@link rpc}, {@link hostSessions}, and an inline `workspace/list` that also
 * hardcoded its rpcId and returned raw text. A change to the headers or the unwrapping rule
 * had to be mirrored in all three. Installed with `addInitScript` because this probe
 * navigates to a second Host (the restart), which an `evaluate`-installed helper would not
 * survive.
 */
const API_HELPER = () => {
  window.__readoptApi = async (method, args) => {
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
    } catch { /* the raw text is reported on failure */ }
    return { status: response.status, text, value: parsed?.result?.value, ok: parsed?.result?.ok, error: parsed?.result?.error }
  }
}

const rpc = (method, args) => page.evaluate(
  ({ method, args }) => window.__readoptApi(method, args), { method, args })

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

/** The Host's session list, normalised. */
const hostSessions = () => page.evaluate(async () => {
  const reply = await window.__readoptApi('session/list', { _request: {} })
  const items = reply.value?.sessions ?? reply.value?.items ?? []
  return (Array.isArray(items) ? items : []).map(item => ({
    id: item.sessionId,
    cwd: item.cwd,
    blank: item.blank,
    title: item.projections?.values?.title ?? null,
  }))
})

let running = child
try {
  const url = await boot(child, 'boot')
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.addInitScript(API_HELPER)
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
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
  console.log(`=== 2. 在里面建一个真实会话（发一条消息，标题 ${SEEDED_TITLE}）===`)
  await page.locator('button[aria-label="新建项目"]').first().click().catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(500)

  // Use the shell's own New Session control, so the Session lands in the default
  // Workspace through the normal path.
  const newSession = page.getByRole('button', { name: NEW_SESSION_LABELS }).first()
  await newSession.click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  const composer = page.locator('[contenteditable="true"], textarea').first()
  await composer.click({ force: true })
  await composer.type(SEEDED_TITLE, { delay: 40 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(9000)
  await dismiss()

  const sessionsBefore = await hostSessions()
  const seeded = sessionsBefore.find(item => item.title === SEEDED_TITLE) ?? null
  console.log(`  Host 会话数: ${sessionsBefore.length}`)
  console.log(`  种下的会话: ${JSON.stringify(seeded)}`)
  // Fail fast: every later line reads `seeded.id`, and with a null seed the probe used to run
  // on and print confident-looking verdicts ("该会话仍渲染在侧栏: false") that described a
  // failed setup rather than a registry behaviour.
  if (seeded === null) {
    throw new Error(`本轮的种子会话没有被创建（标题 ${SEEDED_TITLE} 未出现在 session/list 里）：UI 流程变了？`)
  }

  const beforeView = await rpc('workspace/initializeDefault', {})
  const beforeWorkspace = beforeView.value?.workspace ?? null
  console.log(`  工作区 sessionIds（删前）: ${JSON.stringify(beforeWorkspace?.sessionIds)}`)

  console.log('')
  console.log('=== 3. 删除该工作区的注册（保留目录与会话）===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: firstId } })
  console.log(`  ok=${String(deleted.ok)}  ${deleted.text.slice(0, 120)}`)

  const afterDelete = await hostSessions()
  console.log(`  删除后 Host 会话数: ${afterDelete.length}`)
  console.log(`  种下的会话是否还在: ${afterDelete.some(item => item.id === seeded.id)}`)
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
  const adoptedImmediately = Array.isArray(newWorkspace?.sessionIds)
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
  // Re-pointed BEFORE awaiting the boot: assigning it afterwards meant a restart that failed
  // to boot jumped to `finally`, which killed the already-dead first child and left this live
  // one orphaned, holding its port.
  running = restarted
  const url2 = await boot(restarted, 'restart boot')

  await page.goto(url2, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(9000)
  await dismiss()

  const afterRestart = await rpc('workspace/initializeDefault', {})
  const restartWorkspace = afterRestart.value?.workspace ?? null
  console.log(`  initializeDefault 返回: ${restartWorkspace === null ? 'null' : `id=${String(restartWorkspace.workspaceId)}`}`)

  // `initializeDefault` returns null once the pointer is dead, so read the registry
  // through the client's own workspace list instead — that is what the sidebar shows.
  const listed = await page.evaluate(async () => {
    const reply = await window.__readoptApi('workspace/list', {})
    return { status: reply.status, text: reply.text.slice(0, 300) }
  })
  console.log(`  workspace/list: ${listed.status} ${listed.text}`)

  // The sidebar rows are the user-visible truth about which Workspace owns what.
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-row-key]')]
    .map(node => ({
      key: node.getAttribute('data-row-key'),
      text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30),
    })))
  console.log(`  侧栏行: ${JSON.stringify(rows)}`)

  const sessionsAfterRestart = await hostSessions()
  console.log(`  Host 会话数: ${sessionsAfterRestart.length}`)
  console.log(`  种下的会话仍在: ${sessionsAfterRestart.some(item => item.id === seeded.id)}`)

  console.log('')
  console.log('=== 最终判定 ===')
  console.log(`  注册时立即收回: ${adoptedImmediately ? '是' : '否'}`)
  const sessionRowPresent = rows.some(row => row.key === `session:${seeded.id}@` || row.key.includes(seeded.id))
  console.log(`  重启后该会话仍渲染在侧栏: ${sessionRowPresent}`)
} finally {
  running?.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
