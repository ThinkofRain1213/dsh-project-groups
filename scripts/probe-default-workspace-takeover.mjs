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
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-default-workspace-takeover.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// One port per supported profile, and an unknown profile is refused rather than mapped
// silently onto the second port: this probe DELETES and rebuilds the default Workspace, so
// attaching to whatever else happened to be listening there would mutate a stranger's
// instance while still reporting results. DSH_PROBE_PORT overrides for a parallel run.
const PROFILE_PORTS = { pg: 17880, official: 17881 }
const PORT = Number(process.env.DSH_PROBE_PORT ?? PROFILE_PORTS[profile])
if (!Number.isInteger(PORT)) {
  console.error(`unknown profile '${profile}'; supported: ${Object.keys(PROFILE_PORTS).join(', ')}`)
  process.exit(2)
}
// `join`, not a literal: the backslashes this used to carry are ordinary characters in a
// filename off Windows, where the spawn then failed with an ENOENT.
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

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
// Started, not awaited: the await moved inside the `try` below, because awaiting it here
// meant a boot rejection (or a browser launch failure) escaped before `finally`, leaving
// the spawned host running and holding the port.
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
let driverError
const consoleErrors = []

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
  // Guarded: unguarded `JSON.parse` turned an HTML/empty error body into a SyntaxError that
  // aborted the whole probe, and a never-checked status meant a 500 was read like a reply.
  const text = await response.text()
  if (!response.ok) return { ok: false, value: undefined, error: { message: `HTTP ${response.status}: ${text.slice(0, 200)}` } }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, value: undefined, error: { message: `non-JSON reply: ${String(error?.message ?? error)}` } }
  }
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
const dismiss = () => dismissShared(page)

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

/**
 * The 默认工作区 card's second line, as rendered: text plus its computed colour.
 *
 * Located structurally, excluding the in-card `role="button"` action (which only exists
 * while the Workspace is missing and would otherwise shift the index), and the shape is
 * asserted: a cosmetic change to the card's spans would previously make this read a
 * different node and turn a real regression into a pass without saying so.
 */
const defaultValueLine = async () => {
  const lines = modeCard('默认工作区').locator('span:not([role="button"])')
  const count = await lines.count()
  if (count !== 2) throw new Error(`默认工作区 卡片结构变了：期望 2 个非动作 span，实际 ${count}`)
  return await lines.nth(1).evaluate(el => ({ text: el.textContent ?? '', color: getComputedStyle(el).color }))
}

/**
 * Resolve one theme token to the colour the browser actually computes.
 *
 * The colour assertions used the literal `rgb(245, 158, 11)`; the warn colour is
 * `--dsw-alias-state-warn-primary`, so a palette change (or the light scheme) would have
 * failed them for a reason unrelated to the feature. Resolved from the live token like the
 * rest of this repo's colour checks.
 */
const tokenColor = (token) => page.evaluate((name) => {
  const probe = document.createElement('span')
  probe.style.color = `var(${name})`
  document.body.append(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value
}, token)

/** The rebuild action inside the 默认工作区 card, when it is present. */
const rebuildAction = () => modeCard('默认工作区').locator('[role="button"]')

try {
  const url = await boot
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Attached after `newPage()`: these used to run against the `undefined` placeholder, so
  // the probe crashed before it asserted anything.
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
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
  const warnColor = await tokenColor('--dsw-alias-state-warn-primary')
  const healthy = await defaultValueLine()
  console.log(`  默认卡第二行: ${JSON.stringify(healthy)}   警告色(${warnColor})`)
  check('1) 卡片显示正常文案', healthy.text.includes('官方首次创建的工作区'), healthy.text)
  check('1) 不告警（非橙色）', healthy.color !== warnColor, `${healthy.color} vs ${warnColor}`)
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
  check('3) 第二行是橙色警告', warned.color === warnColor, `${warned.color} vs ${warnColor}`)
  check('3) 出现重建按钮', await rebuildAction().count() === 1,
    `count=${String(await rebuildAction().count())}`)

  console.log('')
  console.log('=== 4. 点重建 ⇒ 二次确认 ⇒ 写入 adoptedPath 且 mode 不变 ===')
  // `storedBase()` answers null when the file is missing or unparsable, and
  // `null?.adoptedPath === undefined` is TRUE — so the check below used to pass precisely
  // when the ground truth could not be read. Assert readability first, then the absence.
  const beforeRebuild = storedBase()
  check('4) 能读到插件的持久状态', beforeRebuild !== null, JSON.stringify(beforeRebuild))
  if (beforeRebuild === null) throw new Error('project_groups.json 不可读，无法判断是否写盘')
  check('4) 按下前 mode 是 default', beforeRebuild.mode === 'default', JSON.stringify(beforeRebuild))
  check('4) 按下前没有 adoptedPath', beforeRebuild.adoptedPath === undefined, JSON.stringify(beforeRebuild))

  console.log('  按第一下应【只弹确认】，不写盘')
  await rebuildAction().click({ force: true })
  await page.waitForTimeout(1200)
  const confirmDialog = await missingDialog().filter({ hasText: '确认重建默认工作区' }).count()
  check('4) 出现确认弹窗', confirmDialog > 0, `count=${String(confirmDialog)}`)
  const beforeConfirm = storedBase()
  check('4) 确认前没有写盘', beforeConfirm !== null && beforeConfirm.adoptedPath === undefined,
    JSON.stringify(beforeConfirm))

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
} catch (error) {
  // Without this the driver had no catch at all: any throw (a failed rpc, a locator
  // timeout, the explicit "no default workspace" abort) skipped the procedure summary and
  // the exit code, so a crashed run surfaced as an unhandled rejection with no PASS/FAIL
  // report — indistinguishable from a green run in log-scraping CI.
  driverError = error
} finally {
  console.log('')
  if (driverError !== undefined) {
    console.log(`探针中断: ${driverError instanceof Error ? driverError.stack : String(driverError)}`)
    failures.push('probe aborted')
  }
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
  child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
  process.exit(failures.length === 0 ? 0 : 1)
}
