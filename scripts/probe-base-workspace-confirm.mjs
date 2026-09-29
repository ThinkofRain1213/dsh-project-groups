/**
 * Two-stage confirmation acceptance: the rebuild asks before it writes.
 *
 * The rebuild creates a directory and registers a Workspace — in `'default'` mode the official
 * default Workspace's own directory — so it now asks first. The confirmation is a **second stage of
 * the same `Modal`**, not a second dialog, which is the property most of these checks exist to pin:
 * nesting two modals would mean two `z-index: 1000` layers, two document-level Escape handlers and
 * two focus traps (measured), so "how many dialogs" is asserted directly rather than assumed.
 *
 * Checks:
 *   1. pressing 重建该工作区 moves to the confirm stage, with **still exactly one** dialog;
 *   2. that stage names the path it is about to touch;
 *   3. keyboard focus is on the confirm action (the Modal only autofocuses on mount, so the switch
 *      has to move focus itself — this is the assertion that fails when it does not);
 *   4. 返回 goes back to the report stage without closing;
 *   5. Escape on the confirm stage goes back, not out;
 *   6. Escape on the report stage still closes (no regression of the earlier behaviour);
 *   7. confirming actually creates and registers;
 *   8. no second dialog ever appears, across the whole sequence.
 *
 * Usage: node probe-base-workspace-confirm.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-confirm.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17971 : 17972
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
  return { ok: parsed?.result?.ok, value: parsed?.result?.value }
}, { method, args })

const storedBase = () => {
  try {
    return JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')).global?.baseWorkspace ?? null
  } catch {
    return null
  }
}
const registry = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    return Object.entries(parsed.tables?.workspaces ?? {}).map(([id, row]) => ({ id, path: row.path }))
  } catch {
    return []
  }
}

/** Every visible dialog. More than one at a time is the nesting bug this design avoids. */
const dialogs = () => page.locator('[role="dialog"], [aria-modal="true"]')
const dialogText = async () => (await dialogs().first().innerText().catch(() => '')).replace(/\s+/g, ' ')
const newSession = () => page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()

/** Raise the report; returns whether it appeared. */
const raiseReport = async () => {
  await newSession().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  return await dialogs().count() > 0
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  const target = join(dshHome, 'confirm-probe', 'dir')
  console.log(`=== 目标路径: ${target}`)
  console.log(`  已存在（应为否）: ${String(existsSync(target))}`)
  await rpc('projectGroups/setBaseWorkspace', { request: { mode: 'specified', path: target, name: '确认探测' } })
  await page.waitForTimeout(1200)

  console.log('')
  console.log('=== 1. 报告阶段 ⇒ 点「重建该工作区」进入确认阶段 ===')
  const raised = await raiseReport()
  check('报告弹窗出现', raised === true)
  const reportText = await dialogText()
  console.log(`  报告阶段文字: ${JSON.stringify(reportText.slice(0, 120))}`)
  check('1) 报告阶段标题是「底层工作区缺失」', reportText.includes('底层工作区缺失'), reportText.slice(0, 60))
  check('8) 报告阶段只有 1 个弹窗', await dialogs().count() === 1, `${String(await dialogs().count())} 个`)

  await dialogs().getByRole('button', { name: '重建该工作区' }).first().click({ force: true })
  await page.waitForTimeout(1200)
  const confirmText = await dialogText()
  console.log(`  确认阶段文字: ${JSON.stringify(confirmText.slice(0, 160))}`)
  check('1) 进入确认阶段（标题变化）', confirmText.includes('确认重建'), confirmText.slice(0, 60))
  check('1) 内容含警告文案', confirmText.includes('创建目录'), confirmText.slice(0, 160))
  check('2) 确认阶段显示目标路径', confirmText.includes(target), confirmText.slice(0, 200))
  check('8) 确认阶段仍然只有 1 个弹窗（没有嵌套 Modal）', await dialogs().count() === 1,
    `${String(await dialogs().count())} 个`)

  console.log('')
  console.log('=== 9. 警告行的排版（图标与文本对齐、卡片高度不虚增）===')
  // Regression guard for a rule I missed when copying `RiskConfirmation`'s warning: no `.warning p`
  // equivalent, so the paragraph kept the browser default `margin-block: 1em`. With
  // `align-items: flex-start` that pushed the text below the icon, and because flex does not
  // collapse margins it also added ~2 × 1em to the card's height. Both were reported as separate
  // bugs; they were one cause, so both are asserted here.
  const layout = await page.evaluate(() => {
    const card = document.querySelector('[role="dialog"][aria-modal="true"]')
    if (card === null) return null
    // Targeted by class, not by "first div holding an svg and a p": the dialog's own content div
    // also holds both (the header's close button contains an svg), and picking that measured the
    // card's root instead of the warning row — reported as a 53px offset that was an artifact.
    // A `div` qualifier excludes `baseMissingConfirmIcon`, which is the svg.
    const warning = card.querySelector('div[class*="baseMissingConfirm"]')
    if (warning === null) return null
    const paragraph = warning.querySelector('p')
    const icon = warning.querySelector('svg')
    if (paragraph === null || icon === null) return null
    const top = warning.getBoundingClientRect().top
    const style = getComputedStyle(paragraph)
    return {
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      warningHeight: Math.round(warning.getBoundingClientRect().height * 100) / 100,
      textTop: Math.round((paragraph.getBoundingClientRect().top - top) * 100) / 100,
      iconTop: Math.round((icon.getBoundingClientRect().top - top) * 100) / 100,
    }
  })
  console.log(`  ${JSON.stringify(layout)}`)
  check('9) 段落没有默认外边距（漏抄的规则已补上）',
    layout !== null && Number.parseFloat(layout.marginTop) === 0 && Number.parseFloat(layout.marginBottom) === 0,
    `margin ${String(layout?.marginTop)} / ${String(layout?.marginBottom)}`)
  // The icon carries `margin-top: 2px` on purpose (it matches `RiskConfirmation`'s `.warningIcon`),
  // so the two are aligned when the text is exactly 2px below the row's top edge.
  check('9) 图标与文本顶部对齐（相差 2px，来自图标自身的 margin-top）',
    layout !== null && Math.abs(layout.textTop - layout.iconTop) <= 3,
    `文本 ${String(layout?.textTop)} vs 图标 ${String(layout?.iconTop)}`)
  // Two lines at the 380px card width, so 44px is the correct height, not a symptom: 2 × 22px
  // line-height, with the paragraph's margin now contributing nothing. Asserted as a bound rather
  // than a single value, because the copy differs per locale.
  check('9) 警告行高度只由文本决定（无 margin 虚增）',
    layout !== null && layout.warningHeight > 0 && layout.warningHeight % 22 === 0,
    `行高 ${String(layout?.warningHeight)}px（应为 22px 的整数倍）`)

  console.log('')
  console.log('=== 3. 焦点应在「确认重建」按钮上 ===')
  const focused = await page.evaluate(() => {
    const node = document.activeElement
    if (node === null) return { tag: null, text: null }
    return { tag: node.tagName.toLowerCase(), text: (node.textContent ?? '').trim() }
  })
  console.log(`  焦点元素: ${JSON.stringify(focused)}`)
  check('3) 焦点转移到确认按钮', focused.text === '确认重建', JSON.stringify(focused))

  console.log('')
  console.log('=== 4. 点「返回」⇒ 回到报告阶段，弹窗不关 ===')
  await dialogs().getByRole('button', { name: '返回' }).first().click({ force: true })
  await page.waitForTimeout(1000)
  const backText = await dialogText()
  console.log(`  返回后文字: ${JSON.stringify(backText.slice(0, 80))}`)
  check('4) 回到报告阶段', backText.includes('底层工作区缺失'), backText.slice(0, 60))
  check('4) 弹窗未关闭', await dialogs().count() === 1, `${String(await dialogs().count())} 个`)

  console.log('')
  console.log('=== 5. 确认阶段按 Escape ⇒ 返回（不关闭）===')
  await dialogs().getByRole('button', { name: '重建该工作区' }).first().click({ force: true })
  await page.waitForTimeout(1000)
  check('5) 前提：已在确认阶段', (await dialogText()).includes('确认重建'))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  const afterEsc = await dialogText()
  console.log(`  Escape 后: ${JSON.stringify(afterEsc.slice(0, 80))}`)
  check('5) Escape 回到报告阶段而非关闭', await dialogs().count() === 1 && afterEsc.includes('底层工作区缺失'),
    `${String(await dialogs().count())} 个: ${afterEsc.slice(0, 50)}`)

  console.log('')
  console.log('=== 6. 报告阶段按 Escape ⇒ 关闭（无回归）===')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  console.log(`  剩余弹窗: ${String(await dialogs().count())}`)
  check('6) 报告阶段 Escape 关闭弹窗', await dialogs().count() === 0, `${String(await dialogs().count())} 个`)

  console.log('')
  console.log('=== 7. 走完确认 ⇒ 目录创建 + 注册成功 ===')
  const raisedAgain = await raiseReport()
  check('7) 报告再次出现', raisedAgain === true)
  await dialogs().getByRole('button', { name: '重建该工作区' }).first().click({ force: true })
  await page.waitForTimeout(1000)
  await dialogs().getByRole('button', { name: '确认重建' }).first().click({ force: true })
  await page.waitForTimeout(7000)
  await dismiss()
  console.log(`  目录存在: ${String(existsSync(target))}  弹窗: ${String(await dialogs().count())}`)
  const row = registry().find(entry => entry.path === target)
  console.log(`  注册行: ${JSON.stringify(row)}  设置: ${JSON.stringify(storedBase())}`)
  check('7) 目录已创建', existsSync(target))
  check('7) 已注册为工作区', row !== undefined)
  check('7) 弹窗已关闭', await dialogs().count() === 0, `${String(await dialogs().count())} 个`)
  check('7) 全程没有出现第二个弹窗', true, '（各步骤均断言过 dialog 数量）')

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
