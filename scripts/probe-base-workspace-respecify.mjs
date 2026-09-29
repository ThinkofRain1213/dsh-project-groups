/**
 * Step 3a acceptance: 重新指定底层工作区 takes the user to the settings card and opens its chooser.
 *
 * The chain crosses two components on two pages, so the probe asserts each link separately and
 * then the whole run:
 *   1. the missing-workspace dialog closes when the button is pressed (it must not follow the user
 *      to the other page);
 *   2. the browser lands on the Plugins page with **our** card mounted — one
 *      `pluginNavigation.openBundle` call does both;
 *   3. the chooser is open, without a further click;
 *   4. cancelling and pressing 重新指定 again reopens it — which is what consumption buys, since a
 *      request left standing would not be a new value;
 *   5. with the card never mounted at request time, the request still opens the chooser (the
 *      mount-ordering case 3a creates).
 *
 * Usage: node probe-base-workspace-respecify.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-respecify.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17985 : 17986
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
  return parsed?.result?.value
}, { method, args })

/** The missing-workspace dialog (its own title). */
const missingDialog = () => page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '底层工作区缺失' })
/** The chooser dialog on the settings card. */
const chooserDialog = () => page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
const card = () => page.locator('[data-plugin-config]').first()
const newSession = () => page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()

/** Drive the missing-workspace dialog into view and press 重新指定. */
const pressRespecify = async () => {
  await newSession().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  const appeared = await missingDialog().count()
  if (appeared === 0) return { appeared: false }
  await missingDialog().getByRole('button', { name: '重新指定底层工作区' }).first().click({ force: true })
  await page.waitForTimeout(4500)
  await dismiss()
  return { appeared: true }
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 准备：让默认工作区解析失败，从而出现缺失弹窗 ===')
  const initial = await rpc('workspace/initializeDefault', {})
  const workspace = initial?.workspace ?? null
  console.log(`  默认工作区: ${String(workspace?.path)}`)
  // A second Workspace, so the chooser has something to list once the default's registration is
  // gone. Without it the isolated profile ends up with an **empty** registry and the chooser
  // correctly shows 「暂无工作区」 — which is a different assertion, not this one.
  const scratch = 'C:\\Users\\Think\\Desktop\\项目\\dsh-project-groups\\scripts'
  const extra = await rpc('workspace/create', { request: { path: scratch } })
  console.log(`  另建工作区: ${String(extra?.workspace?.workspaceId)}`)
  check('已建第二个工作区供弹窗列出', extra?.workspace?.workspaceId !== undefined)
  const deleted = await rpc('workspace/delete', { request: { workspaceId: workspace.workspaceId } })
  check('已删除默认工作区的注册', deleted?.deleted === true)

  console.log('')
  console.log('=== 1. 点「重新指定底层工作区」===')
  const before = await card().count()
  console.log(`  起点卡片数: ${String(before)}`)
  const pressed = await pressRespecify()
  check('缺失弹窗先出现（前提成立）', pressed.appeared === true)

  console.log('')
  console.log('=== 2. 缺失弹窗应已关闭（不跟着跳到另一页面）===')
  const missingAfter = await missingDialog().count()
  console.log(`  缺失弹窗数: ${String(missingAfter)}`)
  check('缺失弹窗已关闭', missingAfter === 0, `${String(missingAfter)} 个`)

  console.log('')
  console.log('=== 3. 应已跳到插件页且挂载我们的卡片 ===')
  const cardAfter = await card().count()
  console.log(`  卡片数: ${String(cardAfter)}`)
  check('卡片已挂载（跳转成功）', cardAfter === 1, `${String(cardAfter)} 个`)

  console.log('')
  console.log('=== 4. 选择弹窗应已自动打开 ===')
  const chooserAfter = await chooserDialog().count()
  console.log(`  选择弹窗数: ${String(chooserAfter)}`)
  check('选择弹窗自动打开', chooserAfter === 1, `${String(chooserAfter)} 个`)
  if (chooserAfter === 1) {
    const options = await chooserDialog().locator('[role="option"]').count()
    console.log(`  选项数: ${String(options)}`)
    check('弹窗列出了工作区', options >= 1, String(options))
  }

  console.log('')
  console.log('=== 5. 取消后离开插件页再回来 ⇒ 弹窗【不得】自己再打开 ===')
  //
  // This is what consumption actually buys, and it is not obvious. Each request is a **fresh
  // object**, so a second request changes identity and notifies even without consumption — which
  // is why "can it open twice" does not discriminate. What consumption prevents is the opposite
  // failure: a request left standing is seen again when the card **remounts**, and the chooser
  // pops open with nobody having asked for it.
  const cancel = chooserDialog().getByRole('button', { name: '取消' }).first()
  if (await cancel.count() > 0) {
    await cancel.click({ force: true })
    await page.waitForTimeout(1200)
  }
  check('取消后选择弹窗关闭', await chooserDialog().count() === 0)
  // The card must genuinely unmount for this to mean anything: re-clicking the panel we are already
  // on, or re-selecting the same bundle, changes nothing — the manager only resets its view when
  // the active panel is *not* `plugins` — and an earlier version of this step was vacuous for
  // exactly that reason (the reverse control still passed).
  //
  // Navigating away needs a New Session that **succeeds**: with the default Workspace's
  // registration deleted, the click raises the missing-workspace report instead, and dismissing
  // that report means nothing navigates at all (measured — the card stayed mounted). So point the
  // setting at the extra Workspace first, which is also the state a user would be in after picking
  // a replacement.
  const pointed = await rpc('projectGroups/setBaseWorkspace', {
    request: { mode: 'specified', path: scratch, name: 'second' },
  })
  console.log(`  已指向第二个工作区: ${JSON.stringify(pointed)}`)
  await page.waitForTimeout(1200)
  await newSession().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  if (await missingDialog().count() > 0) {
    await missingDialog().getByRole('button', { name: '取消' }).first().click({ force: true })
    await page.waitForTimeout(1200)
  }
  const cardAway = await card().count()
  console.log(`  打开会话后卡片数: ${String(cardAway)}`)
  check('卡片确实卸载了（否则消费测不到）', cardAway === 0, `${String(cardAway)} 个`)
  // Remount it: back to the Plugins panel, then activate our bundle's row.
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click({ force: true })
  await page.waitForTimeout(3000)
  await dismiss()
  const entry = page.locator('text=dsh-project-groups').first()
  if (await entry.count() > 0) {
    await entry.click({ force: true })
    await page.waitForTimeout(3000)
    await dismiss()
  }
  const cardRemounted = await card().count()
  const chooserAfterRemount = await chooserDialog().count()
  console.log(`  卡片重新挂载: ${String(cardRemounted)}  选择弹窗数: ${String(chooserAfterRemount)}`)
  check('卡片确实重新挂载了（前提成立）', cardRemounted === 1, `${String(cardRemounted)} 个`)
  check('弹窗没有自己重新弹出（消费生效）', chooserAfterRemount === 0, `${String(chooserAfterRemount)} 个`)

  console.log('')
  console.log('=== 6. 重新挂载后再次「重新指定」⇒ 仍能打开（消费没有把它弄坏）===')
  // The missing report needs a broken setting again: step 5 pointed it at a live Workspace so that
  // the New Session would actually navigate. Put it back on the deleted one to raise the report.
  await rpc('projectGroups/setBaseWorkspace', { request: { mode: 'specified', path: workspace.path, name: 'gone' } })
  await page.waitForTimeout(1500)
  const second = await pressRespecify()
  const chooserSecond = await chooserDialog().count()
  console.log(`  第二次缺失弹窗: ${String(second.appeared)}  选择弹窗: ${String(chooserSecond)}`)
  check('第二次仍能打开选择弹窗', chooserSecond === 1, `${String(chooserSecond)} 个`)

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
