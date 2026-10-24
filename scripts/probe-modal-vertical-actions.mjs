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
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-modal-vertical-actions.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17850 : 17851))
// `join` rather than Windows-only separators: the literal is an invalid path wherever
// `asarRoot` is a POSIX path.
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// Spawned inside the `try` below, so that a failed spawn, a boot timeout or a launch error
// all still reach the `finally` that reaps the Host. While the spawn sat above the `try`, a
// boot timeout rejected the top-level await and left the Electron Host running on the port.
let child
let browser
let page

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

/**
 * Run one setup step, naming it in the failure.
 *
 * The steps below used to swallow their errors and continue; a drifted selector then surfaced
 * only as `无法测量: no dialog open`, which names the symptom and hides the cause.
 * @param label - what the step was trying to do.
 * @param action - the step itself.
 * @returns whatever the step returned.
 */
const step = async (label, action) => {
  try {
    return await action()
  } catch (error) {
    throw new Error(`setup step failed — ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  // 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
  // 进程存活但从不监听端口 —— 那时下面这行 spawn 等到的只是一条误导性的超时。
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile })
  if (prepared.problem !== undefined) {
    console.error(`无法准备探针环境：${prepared.problem}`)
    process.exit(2)
  }
  child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const url = await new Promise((resolve, reject) => {
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

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(8000)
  await dismiss()

  // Open a real `Modal` with a footer: the plugin's own rename dialog.
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill('竖排')
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)

  const row = page.locator('[data-row-key^="workspace:"]', { hasText: '竖排' }).first()
  await step('hover the 竖排 row', () => row.hover({ timeout: 5000 }))
  await page.waitForTimeout(400)
  // The row's menu trigger. `button[aria-haspopup="menu"]` is preferred and the label
  // heuristic is only the fallback: `.first()` over a combined selector list resolves by
  // document order, so the old `button[aria-haspopup="menu"], button[aria-label*="项目"]`
  // could pick an unrelated labelled button and open the wrong menu.
  const menuTriggers = row.locator('button[aria-haspopup="menu"]')
  const trigger = (await menuTriggers.count()) > 0
    ? menuTriggers.first()
    : row.locator('button[aria-label*="项目"]').first()
  await step(`open the 竖排 row menu (aria-haspopup=${String(await menuTriggers.count())})`,
    () => trigger.click({ force: true }))
  await page.waitForTimeout(600)
  const renameEntry = page.getByRole('menuitem', { name: /编辑项目/ }).first()
  // Was `if (count > 0) click` and then carry on: a menu that never opened was reported as
  // `无法测量: no dialog open`, i.e. as a measurement failure rather than a setup failure.
  if (await renameEntry.count() === 0) {
    throw new Error('setup failed — the 「编辑项目」 menu item never appeared: the row menu did not open, or its copy changed')
  }
  await step('click 编辑项目', () => renameEntry.click({ force: true }))
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
    // The footer is the lowest common ancestor of the labelled buttons — but a labelled button
    // outside the footer (a header action) would make that ancestor the dialog itself, and
    // `footer.replaceChildren(...)` below would then wipe the dialog's contents rather than the
    // footer's. So the climb stops at the dialog and refuses to mutate when it got there.
    let footer = buttons[0].parentElement
    while (footer !== null && footer !== dialog && !buttons.every(button => footer.contains(button))) {
      footer = footer.parentElement
    }
    if (footer === null) return { error: 'no footer' }
    if (footer === dialog) {
      return { error: 'no footer container: the labelled buttons do not share an ancestor below the dialog' }
    }

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

    return {
      footerStyleBefore: {
        display: footerStyleBefore.display,
        direction: footerStyleBefore.flexDirection,
        justify: footerStyleBefore.justifyContent,
      },
      dialogWidth: Math.round(dialogRect.width),
      beforeHeight,
      report,
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
    console.log(`  内容宽按钮宽度: ${JSON.stringify(content?.buttons?.map(b => b.width) ?? [])}`)
    // Looked up by label rather than assuming index 1: if the template button had no text node
    // the fallback path fires and the button order/identity can differ, which used to throw a
    // raw `TypeError` out of the verdict instead of reporting which label was missing.
    const second = full.buttons.find(button => button.label === LABELS[1])
    if (second === undefined) {
      console.log(`  ⇒ 没有识别出「${LABELS[1]}」按钮（实测按钮: ${JSON.stringify(full.buttons.map(b => b.label))}）`)
    } else {
      console.log(`  ⇒ 用户措辞「${LABELS[1]}」需要 ${String(second.natural)}px；`)
      console.log(`     全宽可用 ${second.available}px ⇒ ${second.fits ? '充裕' : '仍不够'}`)
    }
  }
} finally {
  // Guarded: the spawn is inside the `try` now, so a synchronous spawn failure must not turn the
  // real error into a `TypeError` from this line.
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
