/**
 * 分支出的会话是否落在父会话的项目下？
 *
 * ## 为什么必须两个入口各测一次
 *
 * 本插件在 `ClientSessions.fork` 上做了一层遮蔽，覆盖三个入口。但两个客户端
 * 调用点走的是**不同路径**：
 *
 *   - 侧栏「分叉会话」/ 快捷键 → `UiWorkspaceService.forkSession` → `this.sessions.fork`
 *   - 消息下方「在新对话中分支」 → `ctx.sessions.fork` **直接调用**
 *
 * 「改一处覆盖三入口」正是本方案的核心主张，所以只测侧栏等于没验证这个主张：
 * 若消息级那条路不成立，测侧栏依然会全绿。
 *
 * ## 为什么直接读存储文件而不是读 DOM
 *
 * `assignments` 是归属的唯一真相，DOM 只是它的投影；读文件既不受渲染时序影响，
 * 也能在分组折叠时依然读到答案。DOM 侧只用一个断言交叉验证「确实显示在项目下」。
 *
 * Usage: node probe-fork-inherits-project.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { ensureProbeProfile, settleOnboarding, dismissModals } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-fork-inherits-project.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = Number(process.env.DSH_PROBE_PORT ?? 17671)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 读归属表：sessionId → projectId。 */
const assignments = async () => {
  try {
    const text = await readFile(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
    const tables = JSON.parse(text).tables ?? {}
    return Object.fromEntries(
      Object.entries(tables.assignments ?? {}).map(([id, record]) => [id, record.projectId]),
    )
  } catch (error) {
    console.log(`  (读取 project_groups.json 失败: ${error.message})`)
    return {}
  }
}

/** 跑一次 CLI 并等它退出；只在准备环境时用（`--dump-config` 与 `plugin add`）。 */
function runCli(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, [BIN, ...args], {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolvePromise({ ok: false, stderr: `spawn failed: ${error.message}` }))
    child.on('exit', (code) => resolvePromise({ ok: code === 0, stderr }))
  })
}

function boot() {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [BIN, '--profile', 'pg', '--port', String(PORT), '--no-open'], {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    let timer
    const fail = (error) => {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      reject(error)
    }
    timer = setTimeout(() => fail(new Error(`timed out booting: ${redactToken(out.slice(-400))}`)), 120_000)
    child.on('error', (error) => fail(new Error(`spawn failed: ${error.message}`)))
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      if (settled) return
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) {
        settled = true
        clearTimeout(timer)
        setTimeout(() => resolve({ child, url: match[1] }), 3000)
      }
    })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('exit', (code) => { fail(new Error(`exited early with ${code}: ${redactToken(out.slice(-400))}`)) })
    // 保留完整的 stdout/stderr，供模型调用失败时取证——「页面上什么都没有」
    // 只能说明 UI 没渲染，不能说明模型调没调、报了什么。
    serverLog = () => out
  })
}

async function stop(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => { child.once('exit', resolve) })
  // 必须真的发信号。只 `Promise.race` 等十秒不发任何信号时，进程永远不会退出，
  // 探针结束（`process.exit`）后 DSH 服务仍占着硬编码的 PORT=17671——下一次跑在
  // boot 阶段就以 `exited early` 或超时失败，而错误信息完全指不到「端口被占」。
  child.kill()
  const released = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (released) {
    // 给操作系统一点时间释放监听套接字。
    await new Promise(resolve => setTimeout(resolve, 500))
  } else {
    console.log('  （警告：进程 10s 内没有退出，端口可能仍被占用）')
  }
}

const origin = () => new URL(page.url()).origin
const token = () => new URL(page.url()).searchParams.get('token') ?? ''

/** 调本插件的 RPC。 */
const rpc = async (method, args) => page.evaluate(async ({ base, key, methodName, callArgs }) => {
  const rpcId = `probe-${Math.random().toString(36).slice(2)}`
  const response = await fetch(`${base}/api/projectGroups/${methodName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': key },
    body: JSON.stringify({
      type: 'client-request', rpcId,
      method: `projectGroups/${methodName}`,
      payload: { args: callArgs },
    }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 由 body 汇报 */ }
  return { status: response.status, result: parsed?.result, body: text.slice(0, 300) }
}, { base: origin(), key: token(), methodName: method, callArgs: args })

/** 侧栏所有会话行。 */
const sessionRows = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')]
  .map(node => ({ key: node.getAttribute('data-row-key'), text: (node.textContent ?? '').trim().slice(0, 40) })))

/**
 * 开一个新会话并等它出现在侧栏，返回它的 session id。
 *
 * **不用「当前选中行」判据**：侧栏行没有 `aria-current` / `data-selected`
 * 之类的选中标记（`Rows.tsx` 只在搜索面板里用 `css.selected`），第一版探针
 * 靠它取 id，取到的是 null，随后 `session:` 空 locator 超时——失败点在探针
 * 自己身上，而不是产品。改为「点新会话 → 等行数增长 → 取差集」，差集里唯一
 * 的那一行就是刚建的会话。
 * @returns 新会话的 id，取不到时为 undefined。
 */
const openNewSession = async () => {
  const before = new Set((await sessionRows()).map(row => row.key))
  await dismissModals(page)
  // 与 `probe-base-workspace-confirm.mjs` 用同一个定位方式：侧栏顶部的按钮是
  // `aria-label`，不是可见文本节点，`getByRole(name)` 在这里匹配不到。
  await page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()
    .click({ force: true })
  await page.waitForTimeout(4000)
  const after = await sessionRows()
  const added = after.filter(row => !before.has(row.key))
  const key = added[0]?.key ?? after[0]?.key
  return key === undefined ? undefined : key.replace(/^session:/, '')
}

const makeProject = async (title) => {
  await dismissModals(page)
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(900)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

let browser
let page
let instance
/** 服务端输出快照，供模型调用失败时取证。 */
let serverLog = () => ''
// 本次探针要真的跑完一个模型轮次（消息级分支按钮只在「已完成轮次」上出现），
// 所以隔离的 DSH_HOME 必须自备一套可用模型，缺一样消息都不会产生任何 session
// 事件（实测：会话日志里只有 header，一条 user/message 都没有）：
//
//   1. 真实凭证；
//   2. `agent-default-model` 的 provider/model；
//   3. **提供该 provider 的插件**。`buddy` 不是 DSH 内置 provider，它由第三方
//      插件 `dsh-providers-hub` 注册，三样缺一模型就跑不起来。
const credentialsSource = process.env.DSH_PROBE_CREDENTIALS
const modelProvider = process.env.DSH_PROBE_PROVIDER ?? 'buddy'
const modelName = process.env.DSH_PROBE_MODEL ?? 'deepseek-v4.1-flash'
// 隔离 profile 需要额外装的 bundle（逗号分隔）。这些是真实 profile 里在用的
// 第三方包，探针 profile 默认只派生 web 模板，不会带上它们。
const extraBundles = (process.env.DSH_PROBE_BUNDLES ?? 'dsh-providers-hub').split(',').filter(Boolean)
if (credentialsSource !== undefined) {
  await copyFile(credentialsSource, join(dshHome, '.credentials.yaml')).catch((error) => {
    console.error(`复制凭证失败：${error.message}`)
    process.exit(2)
  })
  console.log(`已借用凭证：${credentialsSource}`)
}
try {
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: 'pg' })
  if (prepared.problem !== undefined) {
    console.error(`无法准备探针环境：${prepared.problem}`)
    process.exit(2)
  }

  // 装入提供 `buddy` 的插件。用 `dsh plugin add` 而不是手改 package.json：
  // 它一并处理依赖解析与 bundle 列表写入，手写会漏掉 node_modules 的安装。
  for (const bundle of extraBundles) {
    const added = await runCli(['plugin', '--profile', 'pg', 'add', bundle])
    if (!added.ok) {
      console.error(`安装 ${bundle} 失败（模型将不可用）：${added.stderr.slice(-500)}`)
      process.exit(2)
    }
    console.log(`已装入 bundle：${bundle}`)
  }

  // 派生 profile 的 patch 里没有 `agent-default-model`，补一项进去。
  //
  // **必须在数组内部追加，不能直接拼在文件末尾**：派生出来的 patch 是一个只有
  // 注释加 `[]` 的文件，直接在后头接 `- id: …` 会变成 `[]` 后面跟一个序列项，
  // 那是非法 YAML。实测表现为 profile 直接认不出来（`profile "pg" does not
  // exist`）——一个和真实原因毫无关联的报错。
  const patchPath = join(dshHome, 'profiles', 'pg', 'cordis.patch.yml')
  const existingPatch = await readFile(patchPath, 'utf8').catch(() => '')
  if (!existingPatch.includes('agent-default-model')) {
    const emptyFlow = /^\s*\[\]\s*$/m
    const entry = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ${modelProvider}
    model: ${modelName}
    reasoningEffort: low`
    const nextPatch = emptyFlow.test(existingPatch)
      ? existingPatch.replace(emptyFlow, entry)
      : `${existingPatch.trimEnd()}
${entry}`
    await writeFile(patchPath, `${nextPatch.trimEnd()}
`, 'utf8')
    console.log(`已补入模型配置：${modelProvider} / ${modelName}`)
  }

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  instance = await boot()
  await page.goto(instance.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(2500)

  const projectTitle = `fork-inh-${Date.now().toString(36)}`
  await makeProject(projectTitle)
  console.log(`项目已建：${projectTitle}`)

  const projects = await rpc('baseline', {})
  const projectId = projects.result?.value?.projectIds?.[0]
  check('读到新建项目的 id', typeof projectId === 'string', JSON.stringify(projects.result?.value?.projectIds))
  if (typeof projectId !== 'string') throw new Error('没有项目 id，后续断言无意义')

  // 一个会话上发一句话并等轮次结束——消息级分支按钮只在「已完成轮次」上可用。
  const sendAndSettle = async (text) => {
    await dismissModals(page)
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 20_000 })
    await composer.click()
    await page.waitForTimeout(300)
    // 逐字输入：编辑器是 Lexical，`fill()` 不触发它的输入管线；`type()` 发的是真实
    // 键盘事件，Lexical 才会把它收进自己的状态。
    await page.keyboard.type(text, { delay: 25 })
    await page.waitForTimeout(800)
    const before = (await composer.innerText()).trim()
    console.log(`  （输入框内容：${JSON.stringify(before)}）`)
    const sendButton = page.locator('button[aria-label="发送消息"], button[aria-label="Send message"]').first()
    const hasSend = await sendButton.count()
    console.log(`  （发送按钮：${hasSend} 个）`)
    if (hasSend > 0) {
      await sendButton.click()
    } else {
      await page.keyboard.press('Enter')
    }
    await page.waitForTimeout(3000)
    const after = (await composer.innerText().catch(() => '')).trim()
    check('消息已发出（输入框清空）', after === '' && before !== '', JSON.stringify({ before, after }))
    // 等轮次结束：给足时间让模型回完。
    await page.waitForTimeout(30_000)
    const bubbles = await page.evaluate(() => document.querySelectorAll('[class*="bubble"], [data-message-role], [class*="messageRow"]').length)
    console.log(`  （页面上消息节点数：${bubbles}）`)
    // 页面上若出现错误提示，把它打出来——否则「消息没进去」只能靠猜。
    const notices = await page.evaluate(() => [...document.querySelectorAll('[role="alert"], [class*="notice"], [class*="error"]')]
      .map(node => (node.textContent ?? '').trim().slice(0, 160)).filter(Boolean).slice(0, 5))
    if (notices.length > 0) console.log(`  （页面提示：${JSON.stringify(notices)}）`)
    return bubbles
  }

  // --- 入口一：侧栏「分叉会话」 ------------------------------------------
  console.log('\n=== 入口一：侧栏「分叉会话」 ===')
  const parentSessionId = await openNewSession()
  check('开出了一个新会话', typeof parentSessionId === 'string', String(parentSessionId))
  // 没有会话 id 就无法继续：后面的每一步都以它为前提，硬跑只会在 locator 上超时，
  // 把一个清晰的「探针前提不成立」拖成一条难以定位的 30 秒超时。
  if (typeof parentSessionId !== 'string') throw new Error('没能取得会话 id，探针前提不成立')

  // 先让它有一个已完成轮次，消息级分支按钮才可用；侧栏分叉也要求有可分支内容。
  await sendAndSettle('probe fork inheritance seed')
  check('会话上产生了一条消息', (await sessionRows()).some(row => row.key.includes(parentSessionId)),
    String(parentSessionId))

  await rpc('assign', { request: { sessionId: parentSessionId, projectId } })
  await page.waitForTimeout(1500)
  const afterAssign = await assignments()
  check('父会话已归入项目', afterAssign[parentSessionId] === projectId,
    JSON.stringify({ got: afterAssign[parentSessionId], want: projectId }))

  // 打开会话行的「...」动作菜单。
  //
  // 不是右键菜单：行的操作菜单由 `Rows.tsx:788` 那个 `IconEllipsisOutlineRegular`
  // 按钮打开，`aria-label` 是 `actions.session.aria`（「会话“{name}”的操作」），
  // 点击它才 `setMenuOpen`。第一版用右键 + `menuitem` 角色双重错位，两次都取到 0。
  const row = page.locator(`[data-row-key="session:${parentSessionId}"]`).first()
  // 必须先点一下行把它变成「当前会话」：菜单项与快捷键都从 `current()` 取目标，
  // 而「刚发过消息」不保证它就是当前会话。
  await row.click({ force: true })
  await page.waitForTimeout(1500)
  await row.hover()
  await page.waitForTimeout(500)
  const actionsButton = row.locator('button[aria-label^="会话"], button[aria-label^="Session actions"]').first()
  const actionsCount = await actionsButton.count()
  check('会话行上有动作菜单按钮', actionsCount > 0, String(actionsCount))
  if (actionsCount > 0) {
    await actionsButton.click({ force: true })
    await page.waitForTimeout(1200)
  }
  const forkItem = page.getByText('分叉会话', { exact: true }).first()
  const forkVisible = await forkItem.count()
  check('会话菜单里有「分叉会话」', forkVisible > 0, String(forkVisible))
  const beforeForkOne = Object.keys(await assignments()).length
  if (forkVisible > 0) {
    await forkItem.click({ force: true })
    await page.waitForTimeout(10000)
  }
  const grewOne = Object.keys(await assignments()).length - beforeForkOne
  console.log(`  （侧栏分叉后归属表增长：${grewOne} 条）`)
  // 分叉没发生时的第二诊断：菜单项要求「当前会话」非空且非 blank
  // （`shortcuts.ts:104-110` 的 `target === undefined || target.blank` 守卫）。
  // 探针刚发过消息，但「发过消息」不等于「成为侧栏的当前会话」——这两件事在
  // DSH 里由不同状态承载，所以这里把当前行打出来，好区分是哪个前提没成立。
  const rowsNow = await sessionRows()
  console.log(`  （当前侧栏行：${JSON.stringify(rowsNow)}）`)

  const afterForkOne = await assignments()
  const forkedOne = Object.keys(afterForkOne).filter(id => id !== parentSessionId
    && afterForkOne[id] === projectId)
  console.log(`归属表：${JSON.stringify(afterForkOne)}`)
  check('侧栏分叉 → 子会话继承父项目', forkedOne.length >= 1, JSON.stringify(forkedOne))

  // --- 入口二：消息下方「在新对话中分支」 --------------------------------
  console.log('\n=== 入口二：消息下方「在新对话中分支」 ===')
  // 同一个父会话即可：它已经有完成轮次，消息级分支按钮就在那轮的消息下方。
  const beforeCount = Object.keys(await assignments()).length
  const branchButtons = page.getByRole('button', { name: /在新对话中分支/ })
  const branchCount = await branchButtons.count()
  check('消息下方有「在新对话中分支」按钮', branchCount > 0, String(branchCount))
  if (branchCount > 0) {
    await branchButtons.last().click({ force: true })
    await page.waitForTimeout(8000)
  }

  const afterForkTwo = await assignments()
  const grown = Object.keys(afterForkTwo).length - beforeCount
  const forkedTwo = Object.keys(afterForkTwo).filter(id => afterForkTwo[id] === projectId)
  console.log(`归属表：${JSON.stringify(afterForkTwo)}`)
  check('消息级分支 → 归属表新增了会话', grown >= 1, `新增 ${String(grown)} 条`)
  // 项目下的会话数 = 父会话 + 每一次成功分支出的子会话。两个入口各一次，
  // 所以下限是 3；写成「>= 2」会把「侧栏入口没生效」也算通过。
  check('消息级分支 → 子会话继承父项目', forkedTwo.length >= 3,
    `项目下共 ${String(forkedTwo.length)} 个会话（期望父 + 两次分支 = 3）`)

  // --- DOM 交叉验证 --------------------------------------------------------
  console.log('\n=== DOM 交叉验证 ===')
  const rows = await sessionRows()
  console.log(`侧栏会话行数：${rows.length}`)
  check('侧栏渲染出了分支出来的会话', rows.length >= 2, `${String(rows.length)} 行`)
} finally {
  if (instance?.child !== undefined && instance.child.exitCode === null) await stop(instance.child)
  if (browser !== undefined) await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
