/**
 * What layout does a Modal footer actually have, so two buttons can split it evenly?
 *
 * The user wants a two-choice dialog: title + description, no acknowledgement
 * checkbox, and the two buttons symmetric — each taking half the row — rather than
 * the shipped right-aligned pair.
 *
 * That is a question about computed layout, not about which component to pick, so
 * this measures a live dialog instead of reading CSS: the Modal's stylesheet is
 * inlined with hashed class names, and a rule read out of a bundle cannot say what
 * the browser finally applies (flex direction, gap, min-width, whether the buttons
 * stretch).
 *
 * The plugin's own rename-project dialog is used because it is already `Modal` +
 * `footer` with two `Button`s — the exact structure the new dialog will have, so
 * whatever this reports is what the new dialog inherits for free.
 *
 * Usage: node probe-modal-footer-layout.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-modal-footer-layout.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a leaked Host from an earlier failed run keeps this port bound, and a silent
// collision shows up only as a boot that hangs until the 120 s timeout.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17810 : 17811))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

let child
let browser
let page

/**
 * Boot the Host and resolve the tokenised dev-server URL.
 *
 * A function, not top-level code, so the boot path runs inside the try/finally below: a boot
 * timeout used to reject before the guarded region was entered, so neither the spawned Host nor
 * the browser was ever cleaned up.
 */
const boot = async () => {
  child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  return new Promise((resolve, reject) => {
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
}

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 8; i += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Later']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        await button.click({ force: true }).catch((error) => console.log(`  (点击「${label}」失败: ${error.message.split('\n')[0]})`))
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(700)
  }
}

/**
 * The footer locator, as page-source text.
 *
 * All three `page.evaluate` bodies below need "the element that directly contains the dialog's
 * buttons", and each one used to inline its own copy of the walk — with the copies already
 * differing (`buttons[0].parentElement` against `buttons[0]?.parentElement ?? null`), which is
 * how three measurements of the same dialog end up disagreeing. Installed once as a page global
 * through `addInitScript`, the same way `lib/row-key.mjs` publishes its parser.
 *
 * The footer is located structurally rather than by class name: the Modal's class is hashed at
 * build time and differs per package, so a name-based selector would silently match nothing.
 */
const FOOTER_OF_SOURCE = `(dialog) => {
  const buttons = [...dialog.querySelectorAll('button')].filter(node => (node.textContent ?? '').trim() !== '')
  if (buttons.length === 0) return { buttons, footer: null }
  let footer = buttons[0].parentElement
  while (footer !== null && !buttons.every(button => footer.contains(button))) footer = footer.parentElement
  return { buttons, footer }
}`

try {
  const url = await boot()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  // Before `goto`, so the helper exists for the page the probe actually measures.
  await page.addInitScript(`window.__footerOf = ${FOOTER_OF_SOURCE};`)
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  // Create a project so its row menu exists to open the edit dialog from.
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill('布局探针')
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)

  const row = page.locator('[data-row-key^="workspace:"]', { hasText: '布局探针' }).first()
  await row.hover({ timeout: 5000 }).catch((error) => console.log(`  (hover 项目行失败: ${error.message.split('\n')[0]})`))
  await page.waitForTimeout(400)
  // The row's "..." menu, then its edit entry. A project row's entry reads 编辑项目.
  // The caught error is logged rather than discarded: a covered/detached button then shows up
  // here, instead of as an unexplained "no dialog" three steps later.
  await row.locator('button[aria-label*="项目"][aria-label*="操作"], button[aria-label*="更多"], button[aria-label*="菜单"]')
    .first().click({ force: true }).catch(async (error) => {
      console.log(`  (第一选择器点击失败，改用 aria-haspopup=menu: ${error.message.split('\n')[0]})`)
      await row.locator('button[aria-haspopup="menu"]').first().click({ force: true })
    })
  await page.waitForTimeout(700)
  const renameEntry = page.getByRole('menuitem', { name: /编辑项目/ }).first()
  if (await renameEntry.count() === 0) {
    console.log('打不开编辑项目菜单：接下来的测量落到当时打开的那个对话框上（可能根本没有对话框）。')
  } else {
    await renameEntry.click({ force: true })
  }
  await page.waitForTimeout(1200)

  /** The open dialog's footer geometry. */
  const layout = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    const dialog = dialogs.find(node => (node.textContent ?? '').includes('编辑项目'))
      ?? dialogs[dialogs.length - 1]
    if (dialog === undefined) return { found: false, buttons: [], footer: null }
    if (typeof window.__footerOf !== 'function') return { found: false, buttons: [], footer: null, note: 'window.__footerOf 未注入' }

    const { buttons, footer } = window.__footerOf(dialog)
    if (footer === null) return { found: true, buttons: [], footer: null, note: '没有带文字的按钮，或找不到共同祖先' }
    const footerStyle = getComputedStyle(footer)
    const footerRect = footer.getBoundingClientRect()

    return {
      found: true,
      dialogTitle: (dialog.textContent ?? '').replace(/\s+/g, ' ').slice(0, 40),
      labels: buttons.map(node => (node.textContent ?? '').trim()),
      footer: {
        display: footerStyle.display,
        flexDirection: footerStyle.flexDirection,
        justifyContent: footerStyle.justifyContent,
        alignItems: footerStyle.alignItems,
        gap: footerStyle.gap,
        width: footerRect === null ? null : Math.round(footerRect.width),
        left: footerRect === null ? null : Math.round(footerRect.left),
        right: footerRect === null ? null : Math.round(footerRect.right),
      },
      buttons: buttons.map(node => {
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        return {
          label: (node.textContent ?? '').trim(),
          width: Math.round(rect.width),
          flex: `${style.flexGrow} ${style.flexShrink} ${style.flexBasis}`,
          minWidth: style.minWidth,
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        }
      }),
    }
  })

  console.log('当前打开的对话框（我们自己的 Modal + 两个 Button）：')
  console.log(JSON.stringify(layout, null, 2))

  // Guard the actual shape, not one field: the early-return branch above hands back
  // `footer: null` with `buttons` as a *number* in the old version, so `footer !== null` was not
  // enough to enter this block safely and `layout.buttons.map` threw a TypeError.
  if (!layout.found || !Array.isArray(layout.buttons) || layout.footer === null || layout.buttons.length === 0) {
    console.log('')
    console.log(`=== 判定 ===\n  无法测量：${layout.note ?? (layout.found ? '没有可用的 footer/按钮' : '没有打开任何对话框')}`)
    console.log('  这是测量前提不成立，不是产品结论；请先确认项目行菜单能打开编辑项目对话框。')
  } else {
    const wider = Math.max(...layout.buttons.map(b => b.width))
    const narrower = Math.min(...layout.buttons.map(b => b.width))
    console.log('')
    console.log('=== 判定 ===')
    console.log(`  footer 是 flex 行: ${layout.footer.display === 'flex' ? '✅ 是' : `❌ 否（${String(layout.footer.display)}）`}`)
    console.log(`  footer 靠右对齐 : ${layout.footer.justifyContent === 'flex-end' ? '✅ flex-end（两个按钮堆在右侧，与用户看到的一致）' : String(layout.footer.justifyContent)}`)
    console.log(`  按钮宽度       : ${JSON.stringify(layout.buttons.map(b => b.width))}  ${wider === narrower ? '等宽' : '不等宽（由内容 + min-width:72px 决定）'}`)
    console.log(`  按钮 flex      : ${JSON.stringify(layout.buttons.map(b => b.flex))}`)
    console.log('')
    console.log('  ⇒ 要"左右对半"，给两个按钮加 flex:1（撑满时配合 footer 的宽度）即可；')
    console.log('    若 footer 是 flex-end，还需让按钮 flex-grow 生效（flex-basis 归零）以平分整行。')

    // Prove the recipe instead of proposing it: apply `flex: 1 1 0` to every footer
    // button and re-measure. `flex-basis: 0` is the part that matters — with
    // `flex-grow: 1` alone the buttons keep their content widths as the base and grow
    // from there, which is still uneven. `min-width: 0` lets them shrink past content.
    const injected = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      const dialog = dialogs[dialogs.length - 1]
      if (dialog === undefined || typeof window.__footerOf !== 'function') return { injected: false }
      const { footer } = window.__footerOf(dialog)
      if (footer === null) return { injected: false }

      const tag = document.createElement('style')
      tag.id = 'probe-even-actions'
      tag.textContent = '[data-probe-even] > button { flex: 1 1 0 !important; min-width: 0 !important; }'
      footer.setAttribute('data-probe-even', '')
      document.head.append(tag)
      return { injected: true }
    })

    if (!injected.injected) {
      console.log('')
      console.log('  未能注入 flex 配方（找不到 footer），跳过重测。')
    } else {
      await page.waitForTimeout(400)
      const after = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
        const dialog = dialogs[dialogs.length - 1]
        const footer = dialog?.querySelector('[data-probe-even]') ?? null
        if (footer === null) return null
        const footerRect = footer.getBoundingClientRect()
        return {
          footerWidth: Math.round(footerRect.width),
          gap: getComputedStyle(footer).gap,
          buttons: [...footer.querySelectorAll('button')].map(node => {
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            return {
              label: (node.textContent ?? '').trim(),
              width: Math.round(rect.width),
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              flex: `${style.flexGrow} ${style.flexShrink} ${style.flexBasis}`,
            }
          }),
        }
      })
      console.log('')
      console.log(`=== 注入 \`flex: 1 1 0\` 后重测 ===`)
      console.log(JSON.stringify(after, null, 2))
      // Two buttons are the premise of the "split evenly" question; `widths[1]` used to be read
      // unconditionally, so a different button count threw instead of reporting.
      if (after !== null && after.buttons.length === 2) {
        const widths = after.buttons.map(b => b.width)
        const delta = Math.abs(widths[0] - widths[1])
        console.log('')
        console.log(`  两个按钮宽度: ${JSON.stringify(widths)}`)
        console.log(`  差值: ${delta}px（gap ${after.gap} 与取整造成的偏差可以忽略）`)
        console.log(`  ⇒ ${delta <= 1 ? '✅ 左右对半成立，配方有效' : delta <= 2 ? '✅ 基本对半（1-2px 取整误差）' : `❌ 未对半，差 ${delta}px`}`)
      } else if (after !== null) {
        console.log('')
        console.log(`  注入后按钮数不是 2（${String(after.buttons.length)}），无法判断"对半"。`)
      }
      // Leave the page as found so a later step in this script is unaffected.
      await page.evaluate(() => { document.getElementById('probe-even-actions')?.remove() })
    }
  }
} finally {
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
