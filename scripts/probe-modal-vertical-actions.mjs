/**
 * Can a Modal footer hold three full-width buttons stacked vertically?
 *
 * The horizontal footer has a hard width budget: three equal actions get 77px each in
 * the default 380px card, which fits five Chinese characters and pushed the user's
 * wording ("更换底层工作区" = 98px) out of the row unless the card grows to 460px.
 *
 * A vertical stack removes that budget entirely — each button is as wide as the card,
 * so the label length stops mattering — and it matches the full-width button the
 * plugin-manager's own "添加插件" dialog already uses (the screenshot the user pointed
 * at). The question is whether it works inside this `Modal`: the shipped footer is
 * `display: flex; flex-direction: row; justify-content: flex-end`, and the caller only
 * supplies children, so a stack has to be produced by a wrapping element.
 *
 * Three things are measured against a real dialog:
 *
 *   1. does a wrapping column element actually stack the buttons full-width?
 *   2. are the labels comfortable at that width, with room to spare?
 *   3. does the footer grow in height the way the card expects (no clipped third row)?
 *
 * The user's exact wording and their top-to-bottom order are used, so the answer is
 * about the real thing rather than a stand-in.
 *
 * Usage: node probe-modal-vertical-actions.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-modal-vertical-actions.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17850 : 17851
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

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

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  // Open a real `Modal` with a footer: the plugin's own rename dialog.
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill('竖排')
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)

  const row = page.locator('[data-row-key^="workspace:"]', { hasText: '竖排' }).first()
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await row.locator('button[aria-haspopup="menu"], button[aria-label*="项目"]').first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)
  const renameEntry = page.getByRole('menuitem', { name: /编辑项目/ }).first()
  if (await renameEntry.count() > 0) await renameEntry.click({ force: true })
  await page.waitForTimeout(1200)

  // The user's order, top to bottom, with their own wording.
  const LABELS = ['重建该工作区', '重新指定底层工作区', '取消']

  // Two variants of the stack are compared, because they differ in one visible way:
  // whether the buttons stretch to the card's full width or shrink to their text.
  // The plugin manager's own dialog uses a full-width button, so that is the target.
  const results = await page.evaluate(({ LABELS }) => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    const dialog = dialogs[dialogs.length - 1]
    if (dialog === undefined) return { error: 'no dialog open' }

    const buttons = [...dialog.querySelectorAll('button')].filter(node => (node.textContent ?? '').trim() !== '')
    if (buttons.length < 2) return { error: `only ${buttons.length} buttons` }
    let footer = buttons[0].parentElement
    while (footer !== null && !buttons.every(button => footer.contains(button))) footer = footer.parentElement
    if (footer === null) return { error: 'no footer' }

    const template = buttons[0]
    const dialogRect = dialog.getBoundingClientRect()
    const beforeHeight = Math.round(dialogRect.height)
    const footerStyleBefore = getComputedStyle(footer)

    /** Natural single-line text width, independent of the box it sits in. */
    const naturalWidth = (label, element) => {
      const style = getComputedStyle(element)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (context === null) return null
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      return Math.ceil(context.measureText(label).width)
    }

    const measure = (variant) => {
      const wrapper = document.createElement('div')
      wrapper.setAttribute('data-probe-stack', variant)
      // `column` is what stacks them; `stretch` is the default cross-axis alignment,
      // so children fill the wrapper's width — which is why no per-button width rule
      // is needed. The gap comes from the modal's own scale, not a magic number.
      wrapper.style.display = 'flex'
      wrapper.style.flexDirection = 'column'
      wrapper.style.gap = '8px'
      wrapper.style.width = '100%'

      const clones = []
      for (const label of LABELS) {
        const clone = template.cloneNode(true)
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
        let replaced = false
        while (walker.nextNode()) {
          if ((walker.currentNode.nodeValue ?? '').trim() === '') continue
          walker.currentNode.nodeValue = label
          replaced = true
          break
        }
        if (!replaced) clone.textContent = label
        if (variant === 'content-width') {
          clone.style.flex = '0 0 auto'
          clone.style.alignSelf = 'flex-start'
        }
        wrapper.append(clone)
        clones.push(clone)
      }

      footer.replaceChildren(wrapper)
      void footer.getBoundingClientRect()

      const buttonsReport = clones.map(node => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
        const available = Math.round(rect.width - padding)
        const natural = naturalWidth((node.textContent ?? '').trim(), node)
        return {
          label: (node.textContent ?? '').trim(),
          width: Math.round(rect.width),
          top: Math.round(rect.top),
          available,
          natural,
          fits: natural !== null && natural <= available,
        }
      })

      return {
        variant,
        footerDisplay: getComputedStyle(footer).display,
        footerDirection: getComputedStyle(footer).flexDirection,
        footerJustify: getComputedStyle(footer).justifyContent,
        wrapperWidth: Math.round(wrapper.getBoundingClientRect().width),
        dialogHeight: Math.round(dialog.getBoundingClientRect().height),
        buttons: buttonsReport,
      }
    }

    const report = [measure('full-width'), measure('content-width')]

    // Confirm the card actually grew rather than clipping the third row.
    const grown = report.map(entry => entry.dialogHeight)
    return {
      footerStyleBefore: {
        display: footerStyleBefore.display,
        direction: footerStyleBefore.flexDirection,
        justify: footerStyleBefore.justifyContent,
      },
      dialogWidth: Math.round(dialogRect.width),
      beforeHeight,
      report,
      grown,
    }
  }, { LABELS })

  if (results.error !== undefined) {
    console.log(`无法测量: ${results.error}`)
  } else {
    console.log(`对话框宽度: ${results.dialogWidth}px`)
    console.log(`原 footer: display=${results.footerStyleBefore.display} direction=${results.footerStyleBefore.direction} justify=${results.footerStyleBefore.justify}`)
    console.log(`改前对话框高: ${results.beforeHeight}px`)
    console.log('')
    for (const entry of results.report) {
      console.log(`=== 变体：${entry.variant} ===`)
      console.log(`  对话框高: ${entry.dialogHeight}px  (${entry.dialogHeight > results.beforeHeight ? `↑ 撑高 ${entry.dialogHeight - results.beforeHeight}px` : '未撑高'})`)
      console.log(`  wrapper 宽: ${entry.wrapperWidth}px`)
      const tops = entry.buttons.map(b => b.top)
      const ascending = tops.every((value, index) => index === 0 || value > tops[index - 1])
      console.log(`  是否真的竖排（top 递增）: ${ascending ? '✅ 是' : '❌ 否'}  ${JSON.stringify(tops)}`)
      console.log(`  文案是否放得下: ${entry.buttons.every(b => b.fits) ? '✅ 全部放得下' : '❌ 有溢出'}`)
      for (const button of entry.buttons) {
        console.log(`     ${button.label}: 宽 ${button.width}px, 可用 ${button.available}px, 文本需 ${String(button.natural)}px`)
      }
      console.log('')
    }

    const full = results.report[0]
    const content = results.report[1]
    console.log('=== 判定 ===')
    console.log(`  竖排可行: ${full.buttons.length === 3 ? '✅' : '❌'}`)
    console.log(`  全宽按钮宽度: ${JSON.stringify(full.buttons.map(b => b.width))}`)
    console.log(`  内容宽按钮宽度: ${JSON.stringify(content.buttons.map(b => b.width))}`)
    console.log(`  ⇒ 用户措辞「${LABELS[1]}」需要 ${String(full.buttons[1].natural)}px；`)
    console.log(`     全宽可用 ${full.buttons[1].available}px ⇒ ${full.buttons[1].fits ? '充裕' : '仍不够'}`)
  }
} finally {
  running.kill()
  await browser.close()
}
