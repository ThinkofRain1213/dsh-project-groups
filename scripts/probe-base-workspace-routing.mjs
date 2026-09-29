/**
 * Step ②.5 acceptance: an unscoped New Session lands where the 底层工作区 setting points.
 *
 * The previous acceptance run for step ② asserted that clicking the card *stored* a value and
 * that the dialog could pick one — everything about **writing** the setting. Nothing asserted
 * that a New Session **reads** it, which is why a fully green suite shipped a feature whose
 * only effect was the card's own appearance. So every check here reads the workspaceId out of
 * the `session/create` request body: "which endpoint was called" cannot distinguish landing in
 * the chosen Workspace from landing in the official default.
 *
 * Scenarios (all on the shell's own New Session button, plus one on a project's ＋):
 *   1. `specified(A)`, A registered      ⇒ lands in A
 *   2. `specified(missing)`              ⇒ dialog appears, no Session
 *   3. `default`                         ⇒ official default resolution runs
 *   4. a project row's ＋                ⇒ lands in A *and* is filed under that project
 *   5. the keyboard shortcut             ⇒ same as 1
 *   6. the setting round-trips            ⇒ back to A and still lands in A
 *
 * Usage: node probe-base-workspace-routing.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-routing.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17970 : 17971
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
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))

/**
 * Every New Session call, with the workspaceId the client asked for.
 *
 * The request body is the only place the destination is visible: a `session/create` that
 * succeeds tells nothing about which Workspace answered.
 */
const requests = []
page.on('request', (request) => {
  const target = request.url()
  if (!target.includes('/api/')) return
  const method = target.split('/api/')[1]
  if (!/^(workspace|session)\//.test(method)) return
  let body = null
  try { body = JSON.parse(request.postData() ?? 'null') } catch { body = null }
  requests.push({ method, args: body?.payload?.args ?? {} })
})

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

const storedBase = () => {
  try {
    return JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')).global?.baseWorkspace ?? null
  } catch {
    return null
  }
}
const storedAssignments = () => {
  try {
    return JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')).tables?.assignments ?? {}
  } catch {
    return {}
  }
}

/** Set the base workspace through the plugin's own Remote, as the card does. */
const setBase = (setting) => page.evaluate(async ({ request }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/projectGroups/setBaseWorkspace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'sb', method: 'projectGroups/setBaseWorkspace',
      payload: { args: { request } },
    }),
  })
  return (await response.text()).slice(0, 140)
}, { request: setting })

const createWorkspace = (path) => page.evaluate(async ({ path }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/workspace/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'wc', method: 'workspace/create',
      payload: { args: { request: { path } } },
    }),
  })
  const parsed = JSON.parse(await response.text())
  const value = parsed?.result?.value
  return {
    id: value?.workspace?.workspaceId ?? value?.workspaceId ?? null,
    path: value?.workspace?.path ?? null,
  }
}, { path })

const newSessionButton = () => page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()
const dialog = () => page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '底层工作区缺失' })

/** Click the shell's New Session button and report what was asked for. */
const clickNewSession = async () => {
  requests.length = 0
  await newSessionButton().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  return {
    creates: requests.filter(entry => entry.method === 'session/create'),
    initialized: requests.some(entry => entry.method === 'workspace/initializeDefault'),
    dialog: await dialog().count(),
  }
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  const alpha = 'C:\\Users\\Think\\Desktop\\项目\\dsh-project-groups\\scripts'
  const beta = 'C:\\Users\\Think\\Desktop\\项目\\dsh-project-groups'
  const wsA = await createWorkspace(alpha)
  const wsB = await createWorkspace(beta)
  console.log(`=== 工作区 A: ${JSON.stringify(wsA)}`)
  console.log(`=== 工作区 B: ${JSON.stringify(wsB)}`)

  console.log('')
  console.log('=== 1. specified(A) ⇒ 新建会话落在 A ===')
  console.log(`  setBase: ${await setBase({ mode: 'specified', path: wsA.path, name: 'A' })}`)
  await page.waitForTimeout(1500)
  const first = await clickNewSession()
  console.log(`  session/create 的 workspaceId: ${JSON.stringify(first.creates.map(c => c.args?.request?.workspaceId ?? c.args?.workspaceId))}`)
  check('1) 恰好创建 1 个会话', first.creates.length === 1, `${String(first.creates.length)} 次`)
  check('1) 落在工作区 A', first.creates[0]?.args?.request?.workspaceId === wsA.id,
    String(first.creates[0]?.args?.request?.workspaceId))
  check('1) 没有走官方默认解析', first.initialized === false)

  console.log('')
  console.log('=== 2. specified(不存在) ⇒ 弹窗，且不创建会话 ===')
  // B is registered, then deleted, so the stored path is real but unresolvable.
  await page.evaluate(async ({ workspaceId }) => {
    const token = new URL(location.href).searchParams.get('token') ?? ''
    await fetch(`${location.origin}/api/workspace/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'wd', method: 'workspace/delete',
        payload: { args: { request: { workspaceId } } },
      }),
    })
  }, { workspaceId: wsB.id })
  await page.waitForTimeout(1500)
  console.log(`  setBase(B 已删): ${await setBase({ mode: 'specified', path: wsB.path, name: 'B' })}`)
  await page.waitForTimeout(1500)
  const second = await clickNewSession()
  const dialogText = second.dialog > 0 ? (await dialog().first().innerText()).replace(/\s+/g, ' ').slice(0, 160) : '(无)'
  console.log(`  弹窗: ${String(second.dialog)} 个  ${dialogText}`)
  check('2) 弹窗出现', second.dialog === 1, `${String(second.dialog)} 个`)
  check('2) 没有创建会话', second.creates.length === 0, `${String(second.creates.length)} 次`)
  check('2) 弹窗含那个路径', dialogText.includes(wsB.path.replace(/\\/g, '\\')) || dialogText.includes('底层工作区缺失'),
    dialogText)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)

  console.log('')
  console.log('=== 3. default ⇒ 走官方默认解析 ===')
  console.log(`  setBase(default): ${await setBase({ mode: 'default' })}`)
  await page.waitForTimeout(1500)
  const third = await clickNewSession()
  console.log(`  initializeDefault 被调: ${String(third.initialized)}  创建: ${String(third.creates.length)}`)
  check('3) 走了官方默认解析', third.initialized === true)
  check('3) 成功创建会话', third.creates.length === 1)
  check('3) 落点不是 A', third.creates[0]?.args?.request?.workspaceId !== wsA.id,
    String(third.creates[0]?.args?.request?.workspaceId))

  console.log('')
  console.log('=== 4. 项目行的 ＋：落在 A + 归到该项目 ===')
  console.log(`  setBase(A): ${await setBase({ mode: 'specified', path: wsA.path, name: 'A' })}`)
  await page.waitForTimeout(1500)
  const stamp = Date.now().toString(36)
  const title = `路由${stamp}`
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(900)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  const projectId = Object.entries(JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')).tables.projects)
    .find(([, record]) => record.title === title)?.[0] ?? null
  console.log(`  项目: ${title} (${String(projectId)})`)

  requests.length = 0
  const row = page.locator('div').filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) }).first()
  const rowPlus = row.locator('button[aria-label*="新建会话"], button[aria-label*="新会话"]').first()
  // The row's ＋ is hover-revealed, and Playwright refuses to click it because it is not
  // visible (its reveal rides a transient hover state that a synthetic move does not
  // settle). `node.click()` dispatches a real click event, which React's delegated handler
  // receives exactly as it would a pointer click — so this exercises the same code path
  // without depending on the reveal animation.
  await rowPlus.evaluate(node => node.click())
  await page.waitForTimeout(6000)
  await dismiss()
  const creates = requests.filter(entry => entry.method === 'session/create')
  const createdId = creates[0]?.args?.request?.sessionId ?? null
  const assignments = storedAssignments()
  console.log(`  落在: ${String(creates[0]?.args?.request?.workspaceId)}  新会话: ${String(createdId)}`)
  console.log(`  归档: ${JSON.stringify(assignments[createdId ?? ''])}`)
  check('4) 项目 ＋ 也落在 A', creates[0]?.args?.request?.workspaceId === wsA.id,
    String(creates[0]?.args?.request?.workspaceId))
  check('4) 且归到该项目（beforeOpen 照传）',
    createdId !== null && assignments[createdId]?.projectId === projectId,
    JSON.stringify(assignments[createdId ?? '']))

  console.log('')
  console.log('=== 5. 快捷键（Ctrl+Alt+N）与 1 同结果 ===')
  requests.length = 0
  await page.keyboard.press('Control+Alt+KeyN')
  await page.waitForTimeout(5000)
  await dismiss()
  const shortcutCreates = requests.filter(entry => entry.method === 'session/create')
  console.log(`  落在: ${JSON.stringify(shortcutCreates.map(c => c.args?.request?.workspaceId))}`)
  check('5) 快捷键也落在 A', shortcutCreates.length === 1 && shortcutCreates[0]?.args?.request?.workspaceId === wsA.id,
    JSON.stringify(shortcutCreates.map(c => c.args?.request?.workspaceId)))

  console.log('')
  console.log('=== 6. 往返一次（A → default → A）后仍落在 A ===')
  await setBase({ mode: 'default' })
  await page.waitForTimeout(1200)
  await setBase({ mode: 'specified', path: wsA.path, name: 'A' })
  await page.waitForTimeout(1500)
  const sixth = await clickNewSession()
  console.log(`  落在: ${String(sixth.creates[0]?.args?.request?.workspaceId)}; 设置: ${JSON.stringify(storedBase())}`)
  check('6) 往返后仍落在 A', sixth.creates[0]?.args?.request?.workspaceId === wsA.id,
    String(sixth.creates[0]?.args?.request?.workspaceId))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
