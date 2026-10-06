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
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-directories-dialog.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = 17971
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
  const parsed = JSON.parse(await response.text())
  return { ok: parsed?.result?.ok === true, error: parsed?.result?.error?.message ?? null }
}, { method, args })

const dialogs = () => page.locator('[role="dialog"], [aria-modal="true"]')
const dialogWith = (text) => dialogs().filter({ hasText: text }).last()
const addProject = () => page.locator('button[aria-label="新建项目"]').first()

/** Every stored project, read straight off the Host's durable unit. */
const storedProjects = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
    const table = parsed.tables?.projects ?? {}
    return (parsed.global?.projectIds ?? []).map(id => table[id]).filter(Boolean)
  } catch {
    return []
  }
}
const directoriesOf = (title) => storedProjects().find(p => p.title === title)?.directories ?? []

/** The directory rows currently rendered in a dialog. */
const directoryRows = (dialog) => dialog.locator('li')

/** Open one project row's edit dialog. */
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

let running = child
/**
 * A failure raised by the driver itself, as opposed to a check.
 *
 * Captured because the `finally` below exits the process: without it a throw
 * anywhere in the steps would skip the summary and be reported as a pass. A probe
 * that can report success after crashing is worse than no probe.
 */
let driverError
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
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
  check('编辑对话框打开', await edit.count() > 0)
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
  check('3) 重开后行数等于存储值', await directoryRows(reopened).count() === 1,
    `rows=${await directoryRows(reopened).count()}, stored=${directoriesOf('dirs').length}`)
  const reopenedText = (await reopened.innerText()).replace(/\s+/g, ' ')
  check('3) 已删的 one 没有回来', !reopenedText.includes('one'), reopenedText.slice(0, 160))
  await reopened.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 4. 无目录的项目：两个对话框都显示空占位 ===')
  const bareEdit = await openEditDialog('bare')
  const bareRows = await directoryRows(bareEdit).count()
  const bareText = (await bareEdit.innerText()).replace(/\s+/g, ' ')
  check('4) 编辑对话框没有目录行', bareRows === 0, `rows=${bareRows}`)
  check('4) 显示未添加关联文件夹', bareText.includes('未添加关联文件夹'), bareText.slice(0, 160))
  await bareEdit.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 5. 新建对话框每次打开都从空开始 ===')
  await addProject().click({ force: true })
  await page.waitForTimeout(900)
  const create = dialogWith('新建项目')
  check('5) 新建对话框打开', await create.count() > 0)
  check('5) 新建时没有目录行', await directoryRows(create).count() === 0,
    `rows=${await directoryRows(create).count()}`)
  check('5) 有添加文件夹按钮', (await create.getByRole('button', { name: '添加文件夹' }).count()) > 0)
  await create.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(600)

  // Reopening must still be empty: a stale list here would be the leak the
  // reset-per-open rule exists to prevent.
  await addProject().click({ force: true })
  await page.waitForTimeout(900)
  const secondCreate = dialogWith('新建项目')
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
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
  await browser.close().catch(() => {})
  running.kill()
  process.exit(failures.length === 0 ? 0 : 1)
}
