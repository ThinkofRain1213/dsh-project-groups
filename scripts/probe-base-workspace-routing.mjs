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
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-routing.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a Host leaked by an earlier failed run keeps this port bound, and the only
// symptom would be an opaque "boot timeout" instead of a clear collision.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17970 : 17971))
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

/**
 * The checkout this probe's fixture Workspaces point at.
 *
 * This was a literal `C:\Users\Think\Desktop\项目\dsh-project-groups...` string, which baked
 * one developer's filesystem into the probe: on any other machine the Workspace either failed
 * to register or registered the **wrong** directory, and the sections below then measured
 * something else with nothing in the output to say so.
 *
 * Defaults to the working directory, which is how the usage line already expects this to be
 * run, and can be overridden with `DSH_PROBE_REPO_ROOT`.
 */
const repoRoot = process.env.DSH_PROBE_REPO_ROOT ?? process.cwd()

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

let child
let browser
let page

/**
 * Every New Session call, with the workspaceId the client asked for.
 *
 * The request body is the only place the destination is visible: a `session/create` that
 * succeeds tells nothing about which Workspace answered.
 */
const requests = []
const recordRequest = (request) => {
  const target = request.url()
  if (!target.includes('/api/')) return
  const method = target.split('/api/')[1]
  if (!/^(workspace|session)\//.test(method)) return
  let body = null
  try { body = JSON.parse(request.postData() ?? 'null') } catch { body = null }
  requests.push({ method, args: body?.payload?.args ?? {} })
}

/**
 * Boot the Host and resolve the tokenised dev-server URL.
 *
 * This is a function, not top-level code, so that the whole boot path runs *inside* the
 * try/finally below: a boot timeout used to reject before the guarded region was entered,
 * so `child.kill()` never ran and the Host kept the fixed port for every later run.
 */
const boot = async () => {
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
  return new Promise((resolve, reject) => {
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
}

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

/**
 * Compare filesystem paths across the differences the Host is free to introduce: separator
 * style (`\` vs `/`), drive-letter case, and a trailing separator. An exact `===` on a Windows
 * path reported "different" for two spellings of the same directory.
 */
const normalizePath = (value) => String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * The plugin's own store, read in one place.
 *
 * This path+try/catch had been copy-pasted per reader (and the inline copy in section 4 had
 * lost the optional chaining the others had). A read failure is reported instead of silently
 * becoming `{}`: an unreadable store would otherwise look exactly like "the plugin stored
 * nothing", which is the regression these checks exist to catch. ENOENT stays quiet because a
 * store that has not been written yet is a legitimate state here.
 */
const readProjectGroups = () => {
  let raw
  try {
    raw = readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') console.log(`  (project_groups.json unreadable: ${error.message})`)
    return {}
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    console.log(`  (project_groups.json is not valid JSON: ${error.message})`)
    return {}
  }
}
const storedBase = () => readProjectGroups().global?.baseWorkspace ?? null
const storedAssignments = () => readProjectGroups().tables?.assignments ?? {}

/**
 * One RPC round trip, sending what the Client Remote sends.
 *
 * The response is always read and the status always kept: three copies of this fetch had
 * drifted, and the copy used by `createWorkspace` ignored `ok` entirely, so a rejected
 * `workspace/create` produced a `null` id that silently corrupted every id comparison below
 * instead of reporting "the setup never happened".
 */
const rpc = (method, args, rpcId) => page.evaluate(async ({ method, args, rpcId }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* reported through `status` and `text` */ }
  return {
    status: response.status,
    // `!== false` rather than `=== true`: the envelope only sets `ok` when it has something
    // to say, and a missing field must not be read as a failure.
    ok: response.ok && parsed?.result?.ok !== false,
    error: parsed?.result?.error ?? null,
    text: text.slice(0, 200),
    value: parsed?.result?.value,
  }
}, { method, args, rpcId })

/**
 * A precondition, asserted.
 *
 * Every scenario below depends on its setup having actually taken effect; when the setup RPC
 * failed silently the section reported a *product* failure for what was a broken harness.
 */
const setup = async (label, method, args, rpcId) => {
  const result = await rpc(method, args, rpcId)
  check(`前置：${label}`, result.ok,
    `status=${String(result.status)} error=${JSON.stringify(result.error)} ${result.text.slice(0, 120)}`)
  return result
}

/** Set the base workspace through the plugin's own Remote, as the card does. */
const setBase = (setting) => setup(`setBase(${setting.mode}${setting.path === undefined ? '' : ` ${setting.path}`})`,
  'projectGroups/setBaseWorkspace', { request: setting }, 'sb')

const createWorkspace = async (path) => {
  const result = await setup(`注册工作区 ${path}`, 'workspace/create', { request: { path } }, 'wc')
  const workspace = result.value?.workspace
  const id = workspace?.workspaceId ?? result.value?.workspaceId ?? null
  if (id === null) {
    // Hard stop, not a soft failure: every later section compares against this id, so a
    // `null` here would turn one broken setup into a series of misleading product failures.
    throw new Error(`workspace/create returned no workspaceId for ${path}: status=${String(result.status)} body=${result.text}`)
  }
  return { id, path: workspace?.path ?? null }
}

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

try {
  const url = await boot()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Registered here — after `newPage()`, before `goto`. At module scope this line ran while
  // `page` was still undefined and threw `Cannot read properties of undefined (reading 'on')`
  // on every single run; after `goto` it would miss the requests the sections assert on.
  page.on('request', recordRequest)
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(8000)
  await dismiss()

  const alpha = join(repoRoot, 'scripts')
  const beta = repoRoot
  const wsA = await createWorkspace(alpha)
  const wsB = await createWorkspace(beta)
  console.log(`=== 工作区 A: ${JSON.stringify(wsA)}`)
  console.log(`=== 工作区 B: ${JSON.stringify(wsB)}`)

  console.log('')
  console.log('=== 1. specified(A) ⇒ 新建会话落在 A ===')
  await setBase({ mode: 'specified', path: wsA.path, name: 'A' })
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
  //
  // The delete used to be fire-and-forget, so a failed `workspace/delete` (wrong token,
  // 4xx/5xx) was silent and the section then measured the wrong state — the dialog assertion
  // below would have reported a *product* failure for a broken harness.
  const deleted = await setup('删除 B 的注册', 'workspace/delete', { request: { workspaceId: wsB.id } }, 'wd')
  if (!deleted.ok) {
    throw new Error('the workspace/delete that this section depends on failed; the dialog assertion below would be meaningless')
  }
  await page.waitForTimeout(1500)
  await setBase({ mode: 'specified', path: wsB.path, name: 'B' })
  await page.waitForTimeout(1500)
  const second = await clickNewSession()
  const dialogText = second.dialog > 0 ? (await dialog().first().innerText()).replace(/\s+/g, ' ').slice(0, 160) : '(无)'
  console.log(`  弹窗: ${String(second.dialog)} 个  ${dialogText}`)
  check('2) 弹窗出现', second.dialog === 1, `${String(second.dialog)} 个`)
  check('2) 没有创建会话', second.creates.length === 0, `${String(second.creates.length)} 次`)
  // The old form was a tautology: `replace(/\\/g, '\\')` replaced a backslash with itself, and
  // the result was OR-ed with the very literal the `dialog()` locator filters on — so it passed
  // for any dialog at all, including one naming the wrong path.
  check('2) 弹窗里出现了 B 的路径',
    dialogText !== '(无)' && normalizePath(dialogText).includes(normalizePath(wsB.path)),
    dialogText)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)

  console.log('')
  console.log('=== 3. default ⇒ 走官方默认解析 ===')
  await setBase({ mode: 'default' })
  await page.waitForTimeout(1500)
  const third = await clickNewSession()
  console.log(`  initializeDefault 被调: ${String(third.initialized)}  创建: ${String(third.creates.length)}`)
  check('3) 走了官方默认解析', third.initialized === true)
  check('3) 成功创建会话', third.creates.length === 1)
  check('3) 落点不是 A', third.creates[0]?.args?.request?.workspaceId !== wsA.id,
    String(third.creates[0]?.args?.request?.workspaceId))

  console.log('')
  console.log('=== 4. 项目行的 ＋：落在 A + 归到该项目 ===')
  await setBase({ mode: 'specified', path: wsA.path, name: 'A' })
  await page.waitForTimeout(1500)
  const stamp = Date.now().toString(36)
  const title = `路由${stamp}`
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(900)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  // Optional chaining, like every other reader of this store: on a fresh home (or after a
  // schema change) `tables`/`projects` may be absent, and the bare access threw a TypeError
  // that aborted the run right after the project had been created.
  const projectId = Object.entries(readProjectGroups().tables?.projects ?? {})
    .find(([, record]) => record.title === title)?.[0] ?? null
  console.log(`  项目: ${title} (${String(projectId)})`)
  // Explicit precondition instead of letting the two assertions below compare against `null`.
  check('前置：新项目出现在 store 里', projectId !== null, `title=${title}`)
  if (projectId === null) {
    throw new Error('the project created in section 4 is not in the store; the ownership assertion below would be meaningless')
  }

  requests.length = 0
  const row = page.locator('div').filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) }).first()
  const rowPlus = row.locator('button[aria-label*="新建会话"], button[aria-label*="新会话"]').first()
  // Exercise the real interaction path first — hover, then a Playwright click — because the
  // row's ＋ is hover-revealed, and a synthetic `node.click()` bypasses hover, actionability
  // and hit-testing: it would green-light this section even if a real user could never reach
  // the button. The synthetic click stays as a recorded fallback, because the reveal rides a
  // transient hover state that a synthetic move does not always settle.
  await row.hover().catch(() => {})
  await page.waitForTimeout(300)
  let pointerPath = 'hover+click'
  try {
    await rowPlus.click({ timeout: 3000 })
  } catch {
    pointerPath = 'synthetic node.click() fallback'
    await rowPlus.evaluate(node => node.click())
  }
  console.log(`  ＋ 的点击路径: ${pointerPath}`)
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
  // Both are optional-chained: a boot timeout or a failed launch now rejects from inside
  // this guarded region, so the cleanup must tolerate never having acquired them.
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
process.exit(failures.length === 0 ? 0 : 1)
