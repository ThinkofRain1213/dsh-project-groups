/**
 * The associated-directory surface of both project dialogs.
 *
 * The Host picker itself is an OS-native chooser and cannot be driven from here,
 * so what this probe covers is everything around it — the parts where a real bug
 * would live:
 *
 *   1. a project stored with directories renders them in its edit dialog;
 *   2. removing one row and saving sends the shortened list to the Host;
 *   3. reopening the dialog shows the **stored** list, not a leftover draft —
 *      the reset-per-open rule both dialogs depend on;
 *   4. a project with no directories shows the empty placeholder in both dialogs;
 *   5. the create dialog starts empty on every open (same reset rule).
 *
 * Usage: node probe-project-directories-dialog.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-directories-dialog.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// `join` + an overridable port: the escaped-backslash path cannot resolve off Windows, and
// the fixed port collided with a parallel probe or a stale server still holding it.
const PROFILE_PORTS = { pg: 17971, official: 17972 }
const PORT = Number(process.env.DSH_PROBE_PORT ?? PROFILE_PORTS[profile])
if (!Number.isInteger(PORT)) {
  console.error(`unknown profile '${profile}'; supported: ${Object.keys(PROFILE_PORTS).join(', ')}`)
  process.exit(2)
}
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Set when the plugin's durable state could not be read (see `storedProjects`). */
let storageError
/** Whether the stuck-mask failure has already been recorded (see `dismiss`). */
let maskStuckReported = false

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
let out = ''
// Created here, awaited inside the `try` below: a boot timeout used to throw before the
// guarded region, so `child.kill()` in `finally` never ran and the host process was left
// holding the port.
const boot = new Promise((resolve, reject) => {
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

let browser
let page

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

/** Invoke one Remote verb from inside the authenticated page. */
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
  // Status checked before parsing: an HTML/empty error body used to throw out of
  // `JSON.parse` and abort the run as a generic "probe aborted" instead of naming the verb.
  const text = await response.text()
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `non-JSON reply: ${String(error?.message ?? error)}` }
  }
  return { ok: parsed?.result?.ok === true, error: parsed?.result?.error?.message ?? null }
}, { method, args })

const dialogs = () => page.locator('[role="dialog"], [aria-modal="true"]')
const dialogWith = (text) => dialogs().filter({ hasText: text }).last()
const addProject = () => page.locator('button[aria-label="新建项目"]').first()

/**
 * Every stored project, read straight off the Host's durable unit.
 *
 * A read or parse failure is RECORDED rather than collapsed into an empty list: an empty
 * list made the later `directoriesOf(...)` assertions fail as if the Host had lost the
 * directories, which is indistinguishable from a real regression. `finally` reports it.
 */
const storedProjects = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
    const table = parsed.tables?.projects ?? {}
    return (parsed.global?.projectIds ?? []).map(id => table[id]).filter(Boolean)
  } catch (error) {
    storageError = error
    return []
  }
}
const directoriesOf = (title) => storedProjects().find(p => p.title === title)?.directories ?? []

/**
 * The directory rows currently rendered in a dialog.
 *
 * Scoped to the list this plugin renders rather than to every `<li>` in the dialog: a
 * dropdown, another `<ul>` or a nested list was counted as a directory row, which flipped
 * the row-count assertions below. The class keeps its local part (`[hash]_[local]`, see
 * `tsdown.config.ts`) even though the hash changes per build — the same idiom `dismiss`
 * uses for `.mask`.
 */
const directoryRows = (dialog) => dialog.locator('ul[class*="directoryList"] > li')

/**
 * Open one project row's edit dialog.
 * @param title - the project title to find the row by.
 * @returns the dialog locator.
 */
const openEditDialog = async (title) => {
  const row = page.locator('[data-row-key^="workspace:"]').filter({ hasText: title }).first()
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  const trigger = row.locator(
    'button[aria-label*="项目"][aria-label*="操作"], button[aria-label*="更多"], button[aria-label*="菜单"]',
  ).first()
  if (await trigger.count() > 0) await trigger.click({ force: true })
  else await row.locator('button[aria-haspopup="menu"]').first().click({ force: true })
  await page.waitForTimeout(700)
  await page.getByRole('menuitem', { name: /编辑项目/ }).first().click({ force: true })
  await page.waitForTimeout(900)
  return dialogWith('编辑项目')
}

/**
 * Assert a dialog opened, and stop the run when it did not.
 *
 * Every step below drives the dialog with forced clicks. If it never opened, the first of
 * those throws and the run is reported only as the generic `probe aborted`, burying the one
 * assertion that mattered ('the dialog did not open') under an unrelated locator timeout.
 * @param dialog - the dialog locator just obtained.
 * @param label - the check label, which doubles as the abort message.
 */
const requireOpen = async (dialog, label) => {
  const opened = await dialog.count() > 0
  check(label, opened)
  if (!opened) throw new Error(`${label}: 对话框没打开，后续断言无法进行`)
}

/**
 * A failure raised by the driver itself, as opposed to a check.
 *
 * Captured because the `finally` below exits the process: without it a throw
 * anywhere in the steps would skip the summary and be reported as a pass. A probe
 * that can report success after crashing is worse than no probe.
 */
let driverError
try {
  const url = await boot
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 准备：一个带两个目录的项目，一个没有目录的项目 ===')
  const made = await rpc('projectGroups/create', {
    request: { title: 'dirs', directories: ['C:\\work\\one', 'D:\\work\\two'] },
  })
  check('带目录的项目已创建', made.ok, String(made.error))
  const bare = await rpc('projectGroups/create', { request: { title: 'bare' } })
  check('无目录的项目已创建', bare.ok, String(bare.error))
  await page.waitForTimeout(2000)
  check('Host 确实存了两个目录',
    directoriesOf('dirs').length === 2, JSON.stringify(directoriesOf('dirs')))

  console.log('')
  console.log('=== 1. 编辑对话框预填已存目录 ===')
  const edit = await openEditDialog('dirs')
  await requireOpen(edit, '编辑对话框打开')
  const rows = await directoryRows(edit).count()
  check('1) 两行目录都渲染出来', rows === 2, `rows=${rows}`)
  const text = (await edit.innerText()).replace(/\s+/g, ' ')
  console.log(`  对话框文字: ${JSON.stringify(text.slice(0, 160))}`)
  check('1) 两行的路径都在', text.includes('one') && text.includes('two'), text)

  console.log('')
  console.log('=== 2. 删掉一行并保存 ⇒ Host 收到缩短后的列表 ===')
  await directoryRows(edit).first().locator('button').first().click({ force: true })
  await page.waitForTimeout(400)
  check('2) 删除后只剩一行', await directoryRows(edit).count() === 1,
    String(await directoryRows(edit).count()))
  // The confirm button must become enabled: the list differs from what is stored.
  const confirm = edit.getByRole('button', { name: '保存' }).first()
  check('2) 保存按钮可用（目录变化被算作脏）', (await confirm.isDisabled()) === false)
  await confirm.click({ force: true })
  await page.waitForTimeout(2500)
  console.log(`  Host 现在的目录: ${JSON.stringify(directoriesOf('dirs'))}`)
  check('2) Host 只留下一个目录', directoriesOf('dirs').length === 1, JSON.stringify(directoriesOf('dirs')))
  check('2) 留下的是第二个', (directoriesOf('dirs')[0] ?? '').includes('two'),
    String(directoriesOf('dirs')[0]))

  console.log('')
  console.log('=== 3. 重开对话框 ⇒ 显示存储值，不是上次的草稿 ===')
  const reopened = await openEditDialog('dirs')
  await requireOpen(reopened, '3) 重开对话框')
  check('3) 重开后行数等于存储值', await directoryRows(reopened).count() === 1,
    `rows=${await directoryRows(reopened).count()}, stored=${directoriesOf('dirs').length}`)
  const reopenedText = (await reopened.innerText()).replace(/\s+/g, ' ')
  check('3) 已删的 one 没有回来', !reopenedText.includes('one'), reopenedText.slice(0, 160))
  await reopened.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 4. 无目录的项目：两个对话框都显示空占位 ===')
  const bareEdit = await openEditDialog('bare')
  await requireOpen(bareEdit, '4) 编辑对话框打开（无目录项目）')
  const bareRows = await directoryRows(bareEdit).count()
  const bareText = (await bareEdit.innerText()).replace(/\s+/g, ' ')
  check('4) 编辑对话框没有目录行', bareRows === 0, `rows=${bareRows}`)
  check('4) 显示未添加关联目录', bareText.includes('未添加关联目录'), bareText.slice(0, 160))
  await bareEdit.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 5. 新建对话框每次打开都从空开始 ===')
  await addProject().click({ force: true })
  await page.waitForTimeout(900)
  const create = dialogWith('新建项目')
  await requireOpen(create, '5) 新建对话框打开')
  check('5) 新建时没有目录行', await directoryRows(create).count() === 0,
    `rows=${await directoryRows(create).count()}`)
  check('5) 有添加目录按钮', (await create.getByRole('button', { name: '添加目录' }).count()) > 0)
  await create.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(600)

  // Reopening must still be empty: a stale list here would be the leak the
  // reset-per-open rule exists to prevent.
  await addProject().click({ force: true })
  await page.waitForTimeout(900)
  const secondCreate = dialogWith('新建项目')
  await requireOpen(secondCreate, '5) 再次打开新建对话框')
  check('5) 再次打开仍旧为空', await directoryRows(secondCreate).count() === 0,
    `rows=${await directoryRows(secondCreate).count()}`)
  await secondCreate.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(600)
} catch (error) {
  driverError = error
} finally {
  console.log('')
  if (driverError !== undefined) {
    // Report the crash, and fail regardless of how many checks had passed: an
    // incomplete run is not a green one.
    console.log(`探针中断: ${driverError instanceof Error ? driverError.stack : String(driverError)}`)
    failures.push('probe aborted')
  }
  if (storageError !== undefined) {
    // Named separately from the assertion failures: a storage read that failed is a setup
    // problem, not evidence about the dialogs.
    console.log(`读取 project_groups.json 失败: ${String(storageError.message ?? storageError)}`)
    failures.push('storage read failed')
  }
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
  // Guarded: when the launch itself threw, `browser` is undefined and dereferencing it here
  // threw out of the `finally`, skipping the exit code entirely.
  if (browser !== undefined) await browser.close().catch(() => {})
  child.kill()
  process.exit(failures.length === 0 ? 0 : 1)
}
