/**
 * Step ② acceptance: the base-workspace card and its chooser.
 *
 * The card grew a second row, so the checks cover the new surface *and* that the
 * pre-existing destination row still behaves. The state is read from the plugin's own
 * domain file, which is the ground truth for "did it write" — a card that only looked
 * right would pass a DOM-only check.
 *
 * Checks:
 *   1. the card carries both rows, and the destination row still works;
 *   2. the base row is two cards, and the selected one uses the official pair
 *      (a module-platform fill and the bluish border);
 *   3. clicking a card writes immediately (that gesture is the commit);
 *   4. 更换… opens a dialog listing every Workspace, each with name *and* path;
 *   5. clicking a row does **not** write — selection is staged;
 *   6. 取消 does not write;
 *   7. 确认 writes, and stores the path that was chosen;
 *   8. 更换… does not switch the card's mode (the `stopPropagation` requirement);
 *   9. a `'specified'` setting whose Workspace is gone reads "已不存在" and is not
 *      silently cleared, and the chooser stops offering the deleted row;
 *  10. 更换… is visibly a button on the selected card (the first reported defect);
 *  11. switching default → specified keeps the remembered choice (the second);
 *  12. no nested-`<button>` React error reaches the console.
 *
 * (This list stopped at 9 while the script grew to 12 sections, so a failure labelled `9)`
 * could mean the missing-Workspace scenario or the console-error one — the two most
 * different outcomes in the file. Labels and this list are aligned now.)
 *
 * Usage: node probe-base-workspace-card.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-card.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17910 : 17911
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

/**
 * The checkout the probe's fixture Workspaces point at.
 *
 * These paths used to be literal `C:\Users\Think\Desktop\项目\dsh-project-groups...` strings,
 * which baked one developer's filesystem into the probe: on any other machine the Workspace either
 * failed to register (the path does not exist) or registered the *wrong* directory, and the probe's
 * later sections then measured something else with nothing in the output to say so.
 *
 * Defaults to the working directory, which is how the usage line already expects this to be run
 * (`node scripts/probe-...` from the checkout), and can be overridden with `DSH_PROBE_REPO_ROOT`.
 */
const repoRoot = process.env.DSH_PROBE_REPO_ROOT ?? process.cwd()

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
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
  // Two ways the backend fails without ever printing its URL, neither of which produced a
  // `dsh web:` line: a failed `spawn` emits `'error'`, and a process that dies early emits
  // `'close'`. Without these handlers the promise stayed pending and the run reported a
  // misleading 'boot timeout' two minutes later for what was really a bad exe path.
  child.on('error', (error) => {
    clearTimeout(timer)
    reject(new Error(`spawn failed for ${exe}: ${error.message}`))
  })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
    reject(new Error(
      `backend exited before printing its URL (code ${String(code)}, signal ${String(signal)}):\n`
      + redactToken(out.slice(-1500)),
    ))
  })
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

// Declared here because the helpers below close over them; **assigned** inside the `try`, so a
// launch failure reaches the `finally` that kills the child and closes the browser. Launching at
// this point threw straight out of the script, leaving the backend running and the browser open.
let browser
let page
const consoleErrors = []
// The two listeners are registered inside the `try`, right after `page` is assigned — see below.
// They used to sit here, which after the launch moved into the `try` meant running against
// `undefined`: `page.on` on `undefined` is a TypeError before the first navigation, so the probe
// could not start at all.
const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

/** The plugin's durable state; the ground truth for "did it write". */
const storedBase = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
    return parsed.global?.baseWorkspace ?? null
  } catch {
    return null
  }
}

/** Open the Plugins page and this bundle's detail page. */
const openCard = async () => {
  await dismiss()
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  await page.locator('text=dsh-project-groups').first().click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()
}

/** The card's own section. */
const card = () => page.locator('[data-plugin-config]').first()
/** The base-workspace row's two cards, by their own accessible text. */
const modeCard = (label) => card().locator('button[aria-pressed]').filter({ hasText: label }).first()

/**
 * POST one `/api/<method>` client-request from inside the page.
 *
 * The envelope — token from `location`, the `x-dsh-token` header, the `client-request` body shape —
 * was copy-pasted four times (two `workspace/create`s, `projectGroups/setBaseWorkspace`,
 * `workspace/delete`), so a change to the header or the body had to be made in four places and a
 * miss would surface as an unexplained RPC failure in one section only.
 *
 * Returns the **status** and the raw text alongside the parsed result, so a caller can tell "the
 * RPC answered no" from "the transport failed or returned a non-JSON body" instead of reading
 * `undefined` as data.
 * @param method - the Remote method name.
 * @param args - its arguments object.
 * @returns `{ status, ok, value, error, text }`.
 */
const callApi = (method, args) => page.evaluate(async ({ method, args }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({
      type: 'client-request', rpcId: `p-${Math.random().toString(36).slice(2)}`,
      method, payload: { args },
    }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* surfaced through status + text */ }
  return {
    status: response.status,
    ok: parsed?.result?.ok,
    value: parsed?.result?.value,
    error: parsed?.result?.error,
    text: text.slice(0, 300),
  }
}, { method, args })

try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Registered here, where `page` exists. Both used to sit at the top level, and once the launch
  // moved inside this `try` that meant `page.on` ran on `undefined` — a TypeError before the first
  // navigation, so the probe could never start. They must also precede the first `goto`, since
  // what they catch is console output produced by the page.
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })

  await settleOnboarding(page)
  await page.waitForTimeout(8000)
  await dismiss()

  // A second Workspace, so the chooser has a real choice to offer.
  const created = await callApi('workspace/create', { request: { path: repoRoot } })
  console.log(`另建一个工作区: ${String(created.status)} ${created.text.slice(0, 200)}`)

  await openCard()

  console.log('')
  console.log('=== 1. 卡片有两行 ===')
  check('1) 配置区存在', await card().count() > 0)
  const cardText = (await card().innerText().catch(() => '')).replace(/\s+/g, ' ')
  console.log(`  卡片文字: ${JSON.stringify(cardText.slice(0, 160))}`)
  check('1) 原有「新会话落点」仍在', cardText.includes('新会话落点'))
  check('1) 新增「底层工作区」', cardText.includes('底层工作区'))
  check('1) 保留原有下拉框（不被新行挤掉）',
    await card().locator('button[aria-haspopup="menu"]').count() === 1)

  console.log('')
  console.log('=== 2. 两张卡片 + 选中态用官方配色 ===')
  const cubes = card().locator('button[aria-pressed]')
  check('2) 底层工作区是两张卡片', await cubes.count() === 2, `count=${String(await cubes.count())}`)
  const styleOf = async (label) => {
    const locator = modeCard(label)
    return await locator.evaluate(node => {
      const style = getComputedStyle(node)
      return { pressed: node.getAttribute('aria-pressed'), background: style.backgroundColor, border: style.borderTopColor }
    })
  }
  const defaultStyle = await styleOf('默认工作区')
  const specifiedStyle = await styleOf('指定工作区')
  console.log(`  默认: ${JSON.stringify(defaultStyle)}`)
  console.log(`  指定: ${JSON.stringify(specifiedStyle)}`)
  check('2) 初始是「默认工作区」被选中', defaultStyle.pressed === 'true')
  check('2) 选中态有填充（非透明）', defaultStyle.background !== 'rgba(0, 0, 0, 0)',
    defaultStyle.background)
  // The official pair: a module-platform fill plus the bluish border.
  check('2) 选中态边框是官方那个蓝', /rgb\(.*\)/.test(defaultStyle.border) && defaultStyle.border !== specifiedStyle.border,
    `selected=${defaultStyle.border} unselected=${specifiedStyle.border}`)

  console.log('')
  console.log('=== 3. 未选过时点「指定工作区」⇒ 打开选择弹窗，而不是写盘 ===')
  // Choosing "specified" *is* choosing a Workspace, so with none stored the card opens
  // the chooser. A write here would be refused: the Host rejects a `'specified'`
  // setting without a path, because it could never resolve. (This is the behaviour the
  // first run of this probe caught.)
  const storeBeforeMode = JSON.stringify(storedBase())
  await modeCard('指定工作区').click({ force: true })
  await page.waitForTimeout(1500)
  const chooser = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
  check('3) 打开选择弹窗而不是写盘', await chooser.count() === 1)
  check('3) 未写盘（没有存出无法解析的设置）', JSON.stringify(storedBase()) === storeBeforeMode,
    `${storeBeforeMode} → ${JSON.stringify(storedBase())}`)
  // The dialog has no way to pick from an empty registry, and there are two here, so
  // commit one through it — which also covers "confirm writes" before the round trip
  // through 更换… below.
  await chooser.locator('[role="option"]').first().click({ force: true })
  await chooser.getByRole('button', { name: '确认' }).first().click({ force: true })
  await page.waitForTimeout(1800)
  const afterMode = storedBase()
  console.log(`  磁盘: ${JSON.stringify(afterMode)}`)
  check('3) 确认后 mode 变为 specified', afterMode?.mode === 'specified', JSON.stringify(afterMode))
  check('3) 卡片反映选择', (await styleOf('指定工作区')).pressed === 'true')

  console.log('')
  console.log('=== 4. 「更换…」打开弹窗，列出所有工作区（名 + 路径）===')
  const change = card().locator('[role="button"]').filter({ hasText: '更换' }).first()
  check('4) 「更换…」存在', await change.count() === 1)
  await change.click({ force: true })
  await page.waitForTimeout(1200)
  const dialog = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
  check('4) 弹窗打开', await dialog.count() === 1)
  const options = dialog.locator('[role="option"]')
  const optionCount = await options.count()
  const optionText = await options.allInnerTexts().catch(() => [])
  console.log(`  选项 ${String(optionCount)} 个: ${JSON.stringify(optionText.map(t => t.replace(/\s+/g, ' ').slice(0, 60)))}`)
  check('4) 列出多个工作区', optionCount >= 2, `count=${String(optionCount)}`)
  check('4) 每行含路径（用于区分同名）',
    optionText.every(text => /[A-Za-z]:\\/.test(text)),
    JSON.stringify(optionText[0]?.slice(0, 80)))

  console.log('')
  console.log('=== 5. 点行不写盘（staged）===')
  const beforeStage = JSON.stringify(storedBase())
  // Pick the row that is NOT currently stored.
  const rows = await options.evaluateAll(nodes => nodes.map(node => node.textContent ?? ''))
  // Asserted, not masked with `?? 0`. When the earlier commit did not persist, `afterMode?.name`
  // is undefined, the sentinel never matches, `findIndex` returns -1 — and falling back to index 0
  // made sections 5 and 7 assert against an unintended row, so they could pass for the wrong
  // reason instead of failing clearly.
  const targetName = afterMode?.name
  check('5) 上一个提交已落盘（可定位目标行）', typeof targetName === 'string' && targetName !== '',
    String(targetName))
  const targetIndex = rows.findIndex(text => !text.includes(targetName ?? '@@@'))
  check('5) 找到目标行', targetIndex >= 0, `index=${String(targetIndex)} rows=${String(rows.length)}`)
  await options.nth(targetIndex >= 0 ? targetIndex : 0).click({ force: true })
  await page.waitForTimeout(1200)
  check('5) 点行后磁盘未变', JSON.stringify(storedBase()) === beforeStage,
    `${beforeStage} → ${JSON.stringify(storedBase())}`)
  const confirmButton = dialog.getByRole('button', { name: '确认' }).first()
  check('5) 确认按钮可用（已 staged）', await confirmButton.isEnabled())

  console.log('')
  console.log('=== 6. 取消不写盘 ===')
  await dialog.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(1200)
  check('6) 弹窗关闭', await dialog.count() === 0)
  check('6) 取消后磁盘未变', JSON.stringify(storedBase()) === beforeStage)

  console.log('')
  console.log('=== 7. 确认才写盘，且路径正确 ===')
  await change.click({ force: true })
  await page.waitForTimeout(1000)
  const dialog2 = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
  const wanted = (await dialog2.locator('[role="option"]').allInnerTexts())[targetIndex >= 0 ? targetIndex : 0]
  await dialog2.locator('[role="option"]').nth(targetIndex >= 0 ? targetIndex : 0).click({ force: true })
  await dialog2.getByRole('button', { name: '确认' }).first().click({ force: true })
  await page.waitForTimeout(1800)
  const committed = storedBase()
  console.log(`  期望来自: ${JSON.stringify(wanted?.replace(/\s+/g, ' ').slice(0, 80))}`)
  console.log(`  磁盘: ${JSON.stringify(committed)}`)
  check('7) 确认后写盘', JSON.stringify(committed) !== beforeStage)
  check('7) 存的是 specified + path', committed?.mode === 'specified' && typeof committed?.path === 'string' && committed.path !== '')
  check('7) 弹窗关闭', await dialog2.count() === 0)

  console.log('')
  console.log('=== 8. 点「更换…」只打开选择弹窗，不改设置 ===')
  //
  // A **guard, not a discriminator** — worth stating because a passing check usually
  // implies it can fail. Measured: removing `stopPropagation` from the inner span leaves
  // this check green, because bubbling cannot change the stored setting in this design:
  //
  //   - with `mode: 'default'` the Host has stripped `path`, so the card's own handler
  //     takes its "no path yet" branch and just opens the picker — the same thing the
  //     span did;
  //   - with a path stored, `setBaseWorkspace` is handed the value already stored, and
  //     `sameBaseWorkspace` returns early.
  //
  // So the checks below pin the *behaviour* users depend on. `stopPropagation` stays as
  // defence in depth (it also keeps the card from taking the click at all), but this
  // probe cannot prove it is needed, and does not claim to.
  const modeBefore = storedBase()?.mode
  await modeCard('默认工作区').click({ force: true })
  await page.waitForTimeout(1500)
  const beforeOpen = storedBase()?.mode
  const change2 = card().locator('[role="button"]').filter({ hasText: '更换' }).first()
  await change2.click({ force: true })
  await page.waitForTimeout(1500)
  const afterOpen = storedBase()?.mode
  const openedByChange = await page.locator('[role="dialog"], [aria-modal="true"]')
    .filter({ hasText: '选择底层工作区' }).count()
  console.log(`  点卡片后 mode=${String(beforeOpen)}；点「更换…」后 mode=${String(afterOpen)}；弹窗数=${String(openedByChange)}`)
  check('8) 点「更换…」打开了选择弹窗', openedByChange === 1)
  check('8) 且没有改动已存的 mode', afterOpen === beforeOpen,
    `${String(beforeOpen)} → ${String(afterOpen)} (初始 ${String(modeBefore)})`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)

  console.log('')
  console.log('=== 9. 工作区消失时标注「已不存在」，且不清空设置 ===')
  // A real deletion, on a Workspace this probe creates so the target is deterministic:
  // `workspace/create` returns the new row, so its id is known without walking the
  // registry (the Workspace namespace has no `baseline` unary — the list arrives only
  // over `follow`, which is a stream and not worth driving from a probe).
  //
  // Only the *registration* is deleted; files and Sessions stay. The card matches by
  // path, so this is also the delete-and-re-add case the stored path is designed to
  // survive: the note appears, and the plugin must not rewrite the user's choice.
  const scratch = join(repoRoot, 'scripts')
  const createdWorkspaceRaw = await callApi('workspace/create', { request: { path: scratch } })
  const createdWorkspace = {
    id: createdWorkspaceRaw.value?.workspace?.workspaceId
      ?? createdWorkspaceRaw.value?.workspaceId ?? null,
    text: createdWorkspaceRaw.text,
  }
  console.log(`  临时工作区: ${JSON.stringify(createdWorkspace)}`)
  check('9) 先建一个临时工作区', createdWorkspace.id !== null)

  if (createdWorkspace.id !== null) {
    // Point the setting at it, through the plugin's own Remote — the same write the
    // card performs.
    const pointed = (await callApi('projectGroups/setBaseWorkspace', {
      request: { mode: 'specified', path: scratch, name: '临时工作区' },
    })).text.slice(0, 160)
    console.log(`  setBaseWorkspace: ${pointed}`)
    await page.waitForTimeout(1200)

    const deleted = (await callApi('workspace/delete', { request: { workspaceId: createdWorkspace.id } })).text.slice(0, 160)
    console.log(`  delete: ${deleted}`)
    await page.waitForTimeout(2500)

    const textAfter = (await card().innerText().catch(() => '')).replace(/\s+/g, ' ')
    console.log(`  卡片文字: ${JSON.stringify(textAfter.slice(0, 220))}`)
    check('9) 卡片标注「已不存在」', textAfter.includes('已不存在'), textAfter.slice(0, 140))
    // The critical half: the plugin must NOT have decided for the user.
    check('9) 设置未被自动清空（仍是 specified + 原 path）',
      storedBase()?.mode === 'specified' && storedBase()?.path === scratch,
      JSON.stringify(storedBase()))
    // And the chooser still lists what IS registered, without the deleted row.
    await card().locator('[role="button"]').filter({ hasText: '更换' }).first().click({ force: true })
    await page.waitForTimeout(1200)
    const remaining = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
    const rowTexts = await remaining.locator('[role="option"]').allInnerTexts().catch(() => [])
    console.log(`  弹窗选项: ${JSON.stringify(rowTexts.map(t => t.replace(/\s+/g, ' ').slice(0, 50)))}`)
    check('9) 弹窗不含已删除的那个', !rowTexts.some(t => t.includes(scratch)))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  }

  console.log('')
  console.log('=== 10. 「更换…」按钮在选中的卡片上要看得出来（用户报的第二点）===')
  //
  // The control first used `--dsw-alias-bg-module-platform`, the very fill the *selected*
  // card uses, so on the selected card it had no visible edges. Measured: a real border
  // and a background distinct from the card's own fill.
  await modeCard('指定工作区').click({ force: true })
  await page.waitForTimeout(1500)
  // Close the chooser if it opened (a gone memory opens it), then re-open deliberately.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const distinguish = await card().locator('[role="button"]').filter({ hasText: '更换' }).first().evaluate((node) => {
    const button = node
    const cube = node.closest('button')
    const buttonStyle = getComputedStyle(button)
    const cubeStyle = cube === null ? null : getComputedStyle(cube)
    return {
      borderWidth: buttonStyle.borderTopWidth,
      borderColor: buttonStyle.borderTopColor,
      buttonFill: buttonStyle.backgroundColor,
      cubeFill: cubeStyle?.backgroundColor ?? null,
    }
  })
  console.log(`  ${JSON.stringify(distinguish)}`)
  const borderVisible = Number.parseFloat(distinguish.borderWidth) > 0
    && distinguish.borderColor !== 'rgba(0, 0, 0, 0)'
  check('10) 「更换…」有可见边框', borderVisible,
    `border=${distinguish.borderWidth} ${distinguish.borderColor}`)
  check('10) 「更换…」的底色与卡片底色不同（不再糊在一起）',
    distinguish.buttonFill !== distinguish.cubeFill,
    `button=${distinguish.buttonFill} cube=${distinguish.cubeFill}`)

  console.log('')
  console.log('=== 11. 切回默认再切回指定：记忆保留，不用重选（用户报的第一点）===')
  //
  // The Host used to strip `path`/`name` on a `'default'` write, so switching away
  // discarded the choice and switching back had to ask again — reported as "cannot
  // persist". The memory must survive.
  //
  // Pick a known Workspace first so the assertions have a definite value.
  await card().locator('[role="button"]').filter({ hasText: '更换' }).first().click({ force: true })
  await page.waitForTimeout(1200)
  const picker = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
  await picker.locator('[role="option"]').first().click({ force: true })
  await picker.getByRole('button', { name: '确认' }).first().click({ force: true })
  await page.waitForTimeout(1800)
  const remembered = storedBase()
  console.log(`  选定的: ${JSON.stringify(remembered)}`)
  check('11) 先成功存下一个 specified', remembered?.mode === 'specified' && typeof remembered?.path === 'string',
    JSON.stringify(remembered))

  await modeCard('默认工作区').click({ force: true })
  await page.waitForTimeout(1800)
  const afterDefault = storedBase()
  console.log(`  切到默认后: ${JSON.stringify(afterDefault)}`)
  check('11) 切到默认后 mode 是 default', afterDefault?.mode === 'default', JSON.stringify(afterDefault))
  check('11) 但 path/name 作为记忆被保留（不被清空）',
    afterDefault?.path === remembered?.path && afterDefault?.name === remembered?.name,
    `期望 path=${String(remembered?.path)} 实际 path=${String(afterDefault?.path)}`)

  await modeCard('指定工作区').click({ force: true })
  await page.waitForTimeout(1800)
  const backToSpecified = storedBase()
  const cardTextBack = (await card().innerText().catch(() => '')).replace(/\s+/g, ' ')
  console.log(`  切回指定后: ${JSON.stringify(backToSpecified)}`)
  console.log(`  卡片文字: ${JSON.stringify(cardTextBack.slice(0, 200))}`)
  check('11) 切回指定恢复了原选择（没有弹窗要求重选）',
    backToSpecified?.mode === 'specified' && backToSpecified?.path === remembered?.path,
    JSON.stringify(backToSpecified))
  check('11) 卡片直接显示那个工作区名（不是「未选择」）',
    cardTextBack.includes(remembered?.name ?? '@@@') && !cardTextBack.includes('未选择'),
    cardTextBack.slice(0, 160))

  console.log('')
  console.log(`=== console errors: ${consoleErrors.length === 0 ? '(none)' : String(consoleErrors.length)} ===`)
  for (const error of consoleErrors.slice(0, 6)) console.log(`  ${error.slice(0, 200)}`)
  check('12) 没有嵌套 button 的 React 报错',
    !consoleErrors.some(line => /validateDOMNesting|descendant of/i.test(line)),
    consoleErrors.find(line => /validateDOMNesting/i.test(line))?.slice(0, 160))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  // `child` directly: `let running = child` was never reassigned, so the alias only added a layer
  // between the reader and the process actually being killed.
  child.kill()
  // Guarded: the launch itself is inside the `try`, and its failure is a case this `finally`
  // exists to handle.
  if (browser !== undefined) await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
