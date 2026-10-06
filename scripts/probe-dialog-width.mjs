/**
 * The project dialogs' card width and the source-folder controls' chrome.
 *
 * Both are presentation facts that only a real render can settle, and both were
 * wrong in the first version: the card was the shipped 380px with no room for a
 * path, and the add/remove controls were bare `<button>`s keeping the browser's
 * native grey fill and inset border.
 *
 *   1. the create dialog's card is wider than the shipped 380px;
 *   2. its "add folder" control carries no native button chrome (transparent
 *      background, no border);
 *   3. a row's remove control is the same 28px transparent icon button;
 *   4. the edit dialog for a **project** is widened too;
 *   5. the edit dialog for a **Workspace** keeps the standard width — the two row
 *      kinds must not drift.
 *
 * Usage: node probe-dialog-width.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-dialog-width.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = 17975
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

/** Card width of the open dialog. */
const widthOf = (dialog) => dialog.evaluate(node => Math.round(node.getBoundingClientRect().width))

/** Computed chrome of a control inside a dialog. */
const chromeOf = (dialog, selector) => dialog.locator(selector).first().evaluate((node) => {
  const style = getComputedStyle(node)
  return {
    background: style.backgroundColor,
    borderWidth: style.borderTopWidth,
    width: Math.round(node.getBoundingClientRect().width),
    height: Math.round(node.getBoundingClientRect().height),
  }
})

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
let driverError
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  await rpc('projectGroups/create', {
    request: { title: 'widths', directories: ['C:\\Users\\Think\\Documents\\A\\B\\C'] },
  })
  await page.waitForTimeout(2000)

  console.log('=== 1/2/3. 新建对话框 ===')
  await addProject().click({ force: true })
  await page.waitForTimeout(1000)
  const create = dialogWith('新建项目')
  const createWidth = await widthOf(create)
  console.log(`  卡片宽度: ${createWidth}px`)
  // The exact width is asserted, not just "wider than the 380px default": the
  // value was chosen deliberately (short of the official 680px browser, which
  // read as loose for this dialog), so a silent drift to another number should
  // fail here rather than pass as "still wider".
  check('1) 新建对话框是 480px', createWidth === 480, `${createWidth}px`)

  // The add control is the second button in the header row (the first text match
  // is the label span's parent).
  const addChrome = await create.getByRole('button', { name: '添加文件夹' }).first().evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      background: style.backgroundColor,
      borderWidth: style.borderTopWidth,
      height: Math.round(node.getBoundingClientRect().height),
    }
  })
  console.log(`  添加文件夹按钮: ${JSON.stringify(addChrome)}`)
  check('2) 添加按钮没有原生灰底', addChrome.background === 'rgba(0, 0, 0, 0)'
    || addChrome.background === 'transparent', addChrome.background)
  check('2) 添加按钮没有原生边框', addChrome.borderWidth === '0px', addChrome.borderWidth)
  check('2) 添加按钮是 sm 高度（28px）', addChrome.height === 28, `${addChrome.height}px`)
  await create.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(700)

  console.log('')
  console.log('=== 4. 项目行的编辑对话框 ===')
  const edit = await openEditDialog('widths')
  const editWidth = await widthOf(edit)
  console.log(`  卡片宽度: ${editWidth}px`)
  check('4) 编辑对话框同样 480px', editWidth === 480, `${editWidth}px`)
  const removeChrome = await chromeOf(edit, 'li button')
  console.log(`  移除按钮: ${JSON.stringify(removeChrome)}`)
  check('3) 移除按钮透明无边框', removeChrome.background === 'rgba(0, 0, 0, 0)'
    && removeChrome.borderWidth === '0px', JSON.stringify(removeChrome))
  check('3) 移除按钮是 28×28', removeChrome.width === 28 && removeChrome.height === 28,
    `${removeChrome.width}×${removeChrome.height}`)
  await edit.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(700)

  console.log('')
  console.log('=== 5. 工作区行保持标准宽度 ===')
  const wsRow = page.locator('[data-row-key^="workspace:"]').filter({ hasText: '默认工作区' }).first()
  await wsRow.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  const wsTrigger = wsRow.locator('button[aria-haspopup="menu"]').first()
  await wsTrigger.click({ force: true }).catch(() => {})
  await page.waitForTimeout(700)
  const wsEntry = page.getByRole('menuitem', { name: /重命名/ }).first()
  if (await wsEntry.count() > 0) {
    await wsEntry.click({ force: true })
    await page.waitForTimeout(900)
    const wsDialog = dialogWith('重命名工作区')
    if (await wsDialog.count() > 0) {
      const wsWidth = await widthOf(wsDialog)
      console.log(`  工作区重命名卡片宽度: ${wsWidth}px`)
      check('5) 工作区对话框保持 380px', wsWidth === 380, `${wsWidth}px`)
      await wsDialog.getByRole('button', { name: '取消' }).first().click({ force: true })
    } else {
      console.log('  未打开工作区重命名对话框，跳过')
    }
  } else {
    console.log('  工作区行没有重命名项，跳过')
  }
} catch (error) {
  driverError = error
} finally {
  console.log('')
  if (driverError !== undefined) {
    console.log(`探针中断: ${driverError instanceof Error ? driverError.stack : String(driverError)}`)
    failures.push('probe aborted')
  }
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
  await browser.close().catch(() => {})
  running.kill()
  process.exit(failures.length === 0 ? 0 : 1)
}
