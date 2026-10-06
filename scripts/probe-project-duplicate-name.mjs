/**
 * Duplicate project names are refused, in both dialogs.
 *
 * The official Workspace list is the model: choosing an existing directory reuses that Workspace
 * instead of registering a second one (the registry indexes by canonical path), and a rename refuses
 * a title another row holds. Projects have no directory — "a project is a Workspace without one" —
 * so only the second rule transfers, and it was missing from **both** the create and rename dialogs
 * as well as from the Host, which is how two projects titled `abc` came to exist and be
 * indistinguishable in the tree and in search.
 *
 * Three layers now hold the rule, and this probe drives the two user-facing ones:
 *   - the create dialog disables 创建 and shows `conflict.projectNamed`;
 *   - the rename dialog does the same for a project row;
 *   - the Host refuses both regardless, so the dialog is a convenience and not the guarantee.
 *
 * Checks:
 *   1. creating a project under an existing name disables 创建 and names the project;
 *   2. changing to a free name re-enables it and the create succeeds;
 *   3. renaming a project onto another project's name disables 编辑项目 and names the project;
 *   4. a free rename works;
 *   5. renaming a project to its **own** current title stays disabled (the shipped behaviour: the
 *      draft equals the stored title), so the self-exclusion cannot be mistaken for a conflict;
 *   6. **the Host refuses a duplicate even when the dialog is bypassed** — the reason the check
 *      cannot live only in the client.
 *
 * Usage: node probe-project-duplicate-name.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-duplicate-name.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17961 : 17962
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
const addProject = () => page.locator('button[aria-label="新建项目"]').first()
const projects = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
    const table = parsed.tables?.projects ?? {}
    return (parsed.global?.projectIds ?? []).map(id => table[id]?.title).filter(Boolean)
  } catch {
    return []
  }
}

/** The dialog currently open, matched by its title text. */
const dialogWith = (text) => dialogs().filter({ hasText: text }).last()

/**
 * Type a title into the open dialog's single text input.
 * @param dialog - the dialog locator.
 * @param value - the draft to enter.
 */
const typeTitle = async (dialog, value) => {
  const input = dialog.locator('input').first()
  await input.fill(value)
  // The checks are computed during render, so a React pass has to land before they are read.
  await page.waitForTimeout(400)
}

/** Whether the dialog's primary action is disabled. */
const primaryDisabled = async (dialog) => dialog.getByRole('button').last().isDisabled()

/**
 * Open one project row's rename dialog.
 *
 * The row's overflow menu is hover-revealed, and its trigger is matched by aria-label (the class
 * name is hashed at build time) with `[aria-haspopup="menu"]` as the fallback — the same pair
 * `probe-modal-footer-layout.mjs` settled on.
 * @param title - the project row's current title.
 * @returns the rename dialog locator.
 */
const openRenameDialog = async (title) => {
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
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 准备：两个项目 alpha / beta ===')
  for (const title of ['beta', 'alpha']) {
    const made = await rpc('projectGroups/create', { request: { title } })
    if (!made.ok) console.log(`  建 ${title} 失败: ${String(made.error)}`)
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(2000)
  console.log(`  当前: ${JSON.stringify(projects())}`)
  check('起点：alpha 与 beta', projects().join(',') === 'alpha,beta', projects().join(','))

  console.log('')
  console.log('=== 1. 新建项目用已有名字 ⇒ 禁用 + 提示 ===')
  await addProject().click({ force: true })
  await page.waitForTimeout(900)
  const createDialog = dialogWith('新建项目')
  check('新建对话框打开', await createDialog.count() > 0)
  await typeTitle(createDialog, 'alpha')
  const createText = (await createDialog.innerText()).replace(/\s+/g, ' ')
  console.log(`  对话框文字: ${JSON.stringify(createText.slice(0, 140))}`)
  check('1) 确认按钮被禁用', await primaryDisabled(createDialog), `disabled=${String(await primaryDisabled(createDialog))}`)
  // The alert alone; see the note on check 3 for why the dialog's whole text is not enough.
  const createAlert = (await createDialog.locator('[role="alert"]').first().innerText().catch(() => ''))
    .replace(/\s+/g, ' ')
  console.log(`  提示文字: ${JSON.stringify(createAlert)}`)
  check('1) 提示说的是【项目】', createAlert.includes('项目') && !createAlert.includes('工作区'), createAlert)
  check('1) 提示里带上了名字', createAlert.includes('alpha'), createAlert)

  console.log('')
  console.log('=== 2. 改成没被占用的名字 ⇒ 可用 + 能创建 ===')
  await typeTitle(createDialog, 'gamma')
  check('2) 确认按钮恢复可用', (await primaryDisabled(createDialog)) === false)
  await createDialog.getByRole('button', { name: '创建' }).first().click({ force: true })
  await page.waitForTimeout(2500)
  console.log(`  当前: ${JSON.stringify(projects())}`)
  check('2) gamma 已创建', projects().includes('gamma'), projects().join(','))

  console.log('')
  console.log('=== 3. 编辑项目撞到别人的名字 ⇒ 禁用 + 提示 ===')
  const renameDialog = await openRenameDialog('alpha')
  check('编辑项目对话框打开', await renameDialog.count() > 0)
  await typeTitle(renameDialog, 'beta')
  const renameText = (await renameDialog.innerText()).replace(/\s+/g, ' ')
  console.log(`  对话框文字: ${JSON.stringify(renameText.slice(0, 140))}`)
  check('3) 确认按钮被禁用', await primaryDisabled(renameDialog))
  // Read the **alert alone**, not the dialog's whole text: the dialog's title is 编辑项目, so a
  // substring test for 项目 against the dialog would pass no matter what the message said — which
  // is exactly how the first version of this check missed that the message said 工作区.
  const renameAlert = (await renameDialog.locator('[role="alert"]').first().innerText().catch(() => ''))
    .replace(/\s+/g, ' ')
  console.log(`  提示文字: ${JSON.stringify(renameAlert)}`)
  check('3) 提示说的是【项目】而不是工作区',
    renameAlert.includes('项目') && !renameAlert.includes('工作区'), renameAlert)
  check('3) 提示里带上了名字', renameAlert.includes('beta'), renameAlert)

  console.log('')
  console.log('=== 4. 改成没被占用的名字 ⇒ 可用 ===')
  await typeTitle(renameDialog, 'alpha-2')
  check('4) 确认按钮恢复可用', (await primaryDisabled(renameDialog)) === false)
  await renameDialog.getByRole('button', { name: '保存' }).first().click({ force: true })
  await page.waitForTimeout(2500)
  console.log(`  当前: ${JSON.stringify(projects())}`)
  check('4) 已改名为 alpha-2', projects().includes('alpha-2'), projects().join(','))

  console.log('')
  console.log('=== 5. 改成自己的原名 ⇒ 保持禁用（官方行为，自排除生效）===')
  const selfDialog = await openRenameDialog('alpha-2')
  await typeTitle(selfDialog, 'alpha-2')
  const selfText = (await selfDialog.innerText()).replace(/\s+/g, ' ')
  console.log(`  对话框文字: ${JSON.stringify(selfText.slice(0, 140))}`)
  check('5) 原名时确认按钮仍禁用', await primaryDisabled(selfDialog))
  check('5) 没有误报冲突', !selfText.includes('已存在名为'), selfText.slice(0, 140))
  await selfDialog.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(700)

  console.log('')
  console.log('=== 6. 绕过对话框：Host 必须拒绝 ===')
  const dup = await rpc('projectGroups/create', { request: { title: 'beta' } })
  console.log(`  create beta: ok=${String(dup.ok)} error=${String(dup.error)}`)
  check('6) Host 拒绝重复标题', dup.ok === false && String(dup.error).includes('already exists'),
    String(dup.error))
  const after = projects()
  console.log(`  当前: ${JSON.stringify(after)}`)
  check('6) 没有多出重复的 beta', after.filter(t => t === 'beta').length === 1, after.join(','))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
