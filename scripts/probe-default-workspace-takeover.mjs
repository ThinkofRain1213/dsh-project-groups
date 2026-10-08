/**
 * Z-5: the default Workspace's warning, its 重建 action, and what a rebuild leaves behind.
 *
 * ## The design this pins
 *
 * The official default Workspace is a **one-way latch**. `defaultWorkspaceId` is written in
 * exactly one place — `createCanonical` under its `firstUse` flag, which only
 * `initializeDefault` sets — and is never cleared. So once the user deletes that
 * registration, `initializeDefault` returns `entities.get(deadId)` → `undefined`, forever,
 * and a New Session in `'default'` mode reports a missing 底层工作区 with no way out.
 *
 * The plugin's answer is to **take the default over** rather than to fix it: a rebuild writes
 * the directory into its own `baseWorkspace.adoptedPath`, keeps `mode: 'default'`, and resolves
 * that path from then on. The official pointer is never consulted again.
 *
 * ## What this probe asserts
 *
 *  1. The card warns: the 默认工作区 card's second line turns amber and says a click will ask.
 *     Never "will be created automatically" — the official flow does not rebuild itself.
 *  2. The 重建默认工作区 action exists **only** while the Workspace is missing.
 *  3. Confirming writes `adoptedPath` and **leaves `mode` as `'default'`** — the highlight does
 *     not jump to 指定工作区, which is the reported defect this whole change fixes.
 *  4. The warning goes away, and the ＋ lands in the rebuilt Workspace with no dialog.
 *
 * ## Why the official directory is never touched
 *
 * `defaultWorkspaceDirectory` starts at the OS Documents folder, so the path is the operator's
 * **real** `~/Documents/deepseek-harness/default-workspace` even though `DSH_HOME` is isolated.
 * `workspace/delete` removes only the registration and keeps the files, which is safe and is
 * exactly the reported scenario. Nothing here removes a directory: the rebuild's `mkdir` is
 * idempotent for one that still exists, and the missing-first case is covered by
 * `probe-base-workspace-rebuild.mjs` against directories that probe creates itself.
 *
 * Usage: node probe-default-workspace-takeover.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-default-workspace-takeover.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17880 : 17881
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
const consoleErrors = []
page.on('pageerror', (error) => consoleErrors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

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
  return { ok: parsed?.result?.ok, value: parsed?.result?.value, error: parsed?.result?.error }
}, { method, args })

/** The official registry's own state; the ground truth for "is it registered again". */
const registryState = () => {
  try {
    const parsed = JSON.parse(readFileSync(`${dshHome}/storages/workspace.json`, 'utf8'))
    return {
      defaultWorkspaceId: parsed.global?.defaultWorkspaceId ?? null,
      rows: Object.entries(parsed.tables?.workspaces ?? {}).map(([id, row]) => ({ id, path: row.path })),
    }
  } catch {
    return null
  }
}

/** The plugin's durable state; the ground truth for "did it write". */
const storedBase = () => {
  try {
    return JSON.parse(readFileSync(`${dshHome}/storages/project_groups.json`, 'utf8')).global?.baseWorkspace ?? null
  } catch {
    return null
  }
}

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

/** Open the Plugins page and this bundle's detail page. */
const openCard = async () => {
  await dismiss()
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  // The card is found by its **localized** plugin title, not the package name: the plugin
  // list renders the bundle's `description`/title, so a `dsh-project-groups` text lookup
  // never matches (the same note `probe-settings-injection-switches.mjs` carries).
  await page.getByText('项目分组', { exact: true }).first().click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()
}

const card = () => page.locator('[data-plugin-config]').first()
const modeCard = (label) => card().locator('button[aria-pressed]').filter({ hasText: label }).first()
const missingDialog = () => page.locator('[role="dialog"], [aria-modal="true"]')
const newSession = () => page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()

/** The 默认工作区 card's second line, as rendered: text plus its computed colour. */
const defaultValueLine = async () => {
  const node = modeCard('默认工作区').locator('span').nth(1)
  return await node.evaluate(el => ({ text: el.textContent ?? '', color: getComputedStyle(el).color }))
}

/** The rebuild action inside the 默认工作区 card, when it is present. */
const rebuildAction = () => modeCard('默认工作区').locator('[role="button"]')

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 1. 起点：官方默认工作区存在，卡片不告警 ===')
  const initial = await rpc('workspace/initializeDefault', {})
  const defaultWorkspace = initial.value?.workspace ?? null
  check('1) 拿到官方默认工作区', defaultWorkspace !== null, JSON.stringify(defaultWorkspace))
  if (defaultWorkspace === null) throw new Error('no default workspace to work with')
  const defaultPath = defaultWorkspace.path
  console.log(`  默认工作区: ${defaultPath}`)
  check('1) 目录存在', existsSync(defaultPath))

  // The setting must be back on 默认 for the card to show the default's own state. The previous
  // runs of other probes may have left it elsewhere.
  await rpc('projectGroups/setBaseWorkspace', { request: { mode: 'default' } })
  await page.waitForTimeout(1200)

  await openCard()
  const healthy = await defaultValueLine()
  console.log(`  默认卡第二行: ${JSON.stringify(healthy)}`)
  check('1) 卡片显示正常文案', healthy.text.includes('官方首次创建的工作区'), healthy.text)
  check('1) 不告警（非橙色）', healthy.color !== 'rgb(245, 158, 11)', healthy.color)
  check('1) 没有重建按钮', await rebuildAction().count() === 0,
    `count=${String(await rebuildAction().count())}`)

  console.log('')
  console.log('=== 2. 删掉官方默认工作区的注册（保留目录）===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: defaultWorkspace.workspaceId } })
  check('2) 删除成功', deleted.value?.deleted === true, JSON.stringify(deleted))
  check('2) 目录仍在（删除只动注册）', existsSync(defaultPath))
  const gone = await rpc('workspace/initializeDefault', {})
  check('2) 官方那条路已死（复现缺失）', (gone.value?.workspace ?? null) === null,
    JSON.stringify(gone.value ?? null))

  console.log('')
  console.log('=== 3. 卡片告警 + 出现重建按钮（探测零副作用）===')
  // The probe fires on a registry change, so the delete above is itself the trigger. Re-open the
  // card to be sure it re-rendered with the new answer.
  await openCard()
  const warned = await defaultValueLine()
  console.log(`  默认卡第二行: ${JSON.stringify(warned)}`)
  check('3) 第二行改成缺失文案', warned.text.includes('缺失'), warned.text)
  check('3) 文案说“会弹窗确认是否重建”，不是“自动创建”',
    warned.text.includes('弹窗') && !warned.text.includes('自动创建'), warned.text)
  check('3) 第二行是橙色警告', warned.color === 'rgb(245, 158, 11)', warned.color)
  check('3) 出现重建按钮', await rebuildAction().count() === 1,
    `count=${String(await rebuildAction().count())}`)

  console.log('')
  console.log('=== 4. 点重建 ⇒ 二次确认 ⇒ 写入 adoptedPath 且 mode 不变 ===')
  check('4) 按下前 mode 是 default', storedBase()?.mode === 'default', JSON.stringify(storedBase()))
  check('4) 按下前没有 adoptedPath', storedBase()?.adoptedPath === undefined, JSON.stringify(storedBase()))

  console.log('  按第一下应【只弹确认】，不写盘')
  await rebuildAction().click({ force: true })
  await page.waitForTimeout(1200)
  const confirmDialog = await missingDialog().filter({ hasText: '确认重建默认工作区' }).count()
  check('4) 出现确认弹窗', confirmDialog > 0, `count=${String(confirmDialog)}`)
  check('4) 确认前没有写盘', storedBase()?.adoptedPath === undefined, JSON.stringify(storedBase()))

  await missingDialog().getByRole('button', { name: '确认', exact: true }).first().click({ force: true })
  await page.waitForTimeout(6000)
  await dismiss()
  const after = storedBase()
  console.log(`  重建后设置: ${JSON.stringify(after)}`)
  check('4) 记下了 adoptedPath', after?.adoptedPath === defaultPath, `${String(after?.adoptedPath)} vs ${defaultPath}`)
  // THE reported defect: the rebuild used to rewrite the mode, which moved the highlight off
  // 默认工作区 and told the user their own repair had changed their setting.
  check('4) mode 仍是 default（高亮不跳）', after?.mode === 'default', JSON.stringify(after?.mode))
  check('4) 目录已恢复', existsSync(defaultPath))
  // The registration is a NEW id: upstream's pointer still names the deleted one and never
  // adopts this row. That is exactly why the plugin resolves its own `adoptedPath` instead.
  const registryAfter = registryState()
  const rebuiltRow = registryAfter?.rows.find(row => row.path === defaultPath)
  check('4) 注册行回来了', rebuiltRow !== undefined, JSON.stringify(registryAfter?.rows))
  check('4) 新注册的 id 与官方指针不同（所以必须靠自己那条）',
    rebuiltRow !== undefined && rebuiltRow.id !== registryAfter?.defaultWorkspaceId,
    `${String(rebuiltRow?.id)} vs ${String(registryAfter?.defaultWorkspaceId)}`)

  console.log('')
  console.log('=== 5. 告警消失，且 ＋ 落在重建后的工作区 ===')
  await openCard()
  const fixed = await defaultValueLine()
  console.log(`  默认卡第二行: ${JSON.stringify(fixed)}`)
  check('5) 告警消失', fixed.text.includes('官方首次创建的工作区'), fixed.text)
  check('5) 重建按钮消失', await rebuildAction().count() === 0,
    `count=${String(await rebuildAction().count())}`)
  const pressed = await modeCard('默认工作区').evaluate(node => node.getAttribute('aria-pressed'))
  check('5) 高亮仍在「默认工作区」', pressed === 'true', String(pressed))

  await dismiss()
  const requests = []
  page.on('request', (request) => {
    if (request.url().includes('/api/session/create')) {
      try { requests.push(request.postData() ?? '') } catch { /* ignore */ }
    }
  })
  await newSession().click({ force: true })
  await page.waitForTimeout(6000)
  await dismiss()
  console.log(`  弹窗: ${String(await missingDialog().count())}  session/create: ${String(requests.length)}`)
  check('5) 不再弹缺失弹窗', await missingDialog().count() === 0)
  check('5) 确实开了会话', requests.length > 0, String(requests.length))

  console.log('')
  console.log('=== 6. 页面无 console 错误（“重建按钮不是真 button”的守卫）===')
  const realErrors = consoleErrors.filter(text => !text.includes('favicon'))
  check('6) 无 validateDOMNesting / 页面错误', realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
