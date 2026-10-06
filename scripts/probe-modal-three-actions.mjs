/**
 * Do three footer actions fit side by side, and what labels survive?
 *
 * The dialog now carries three choices (cancel / switch / rebuild), which is one more
 * than the footer was measured with. A two-action footer gave each button 163px in a
 * 380px dialog; three actions leave roughly 105px each, and Chinese labels are
 * full-width, so a seven-character label can exceed the cell and either wrap or be
 * clipped — and a wrapped action row reads as broken.
 *
 * Measuring beats estimating here because the real limit is not the character count:
 * it is the Button's own padding, font metrics, and whether the label wraps. So the
 * open dialog's footer is rebuilt in place with three real (cloned) Buttons carrying
 * candidate labels, the same `flex: 1 1 0` recipe is applied, and each label is
 * checked for wrapping by comparing its scroll width against its client width.
 *
 * Labels are tested in the order they would appear, and reported per candidate so the
 * wording can be chosen against a number rather than a guess.
 *
 * Usage: node probe-modal-three-actions.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: probe-modal-three-actions.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17840 : 17841
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

  // Open the plugin's own rename dialog: `Modal` + a two-button footer, i.e. the
  // structure the new dialog will have.
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill('三按钮')
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)

  const row = page.locator('[data-row-key^="workspace:"]', { hasText: '三按钮' }).first()
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  const menuTrigger = row.locator('button[aria-haspopup="menu"], button[aria-label*="项目"]').first()
  await menuTrigger.click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)
  const renameEntry = page.getByRole('menuitem', { name: /编辑项目/ }).first()
  if (await renameEntry.count() > 0) await renameEntry.click({ force: true })
  await page.waitForTimeout(1200)

  // Candidate label sets, from shortest to the user's own wording.
  const candidates = [
    ['取消', '更换', '重建'],
    ['取消', '更换底层', '重建工作区'],
    ['取消', '更换底层工作区', '重建该工作区'],
    ['取消', '指定其他工作区', '重建该工作区'],
  ]

  // Dialog widths to sweep, so "what does the user's exact wording cost" is answered
  // as a number rather than as advice to shorten it. The default card is 380px, which
  // the two-button footer already fills; a wider card is a class on the Modal.
  const widths = [380, 420, 460, 500]

  const results = await page.evaluate(({ candidates, widths }) => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    const dialog = dialogs[dialogs.length - 1]
    if (dialog === undefined) return { error: 'no dialog open' }
    const buttons = [...dialog.querySelectorAll('button')].filter(node => (node.textContent ?? '').trim() !== '')
    if (buttons.length < 2) return { error: `only ${buttons.length} buttons` }
    let footer = buttons[0].parentElement
    while (footer !== null && !buttons.every(button => footer.contains(button))) footer = footer.parentElement
    if (footer === null) return { error: 'no footer' }

    const template = buttons[0]
    const tag = document.createElement('style')
    tag.id = 'probe-three-actions'
    tag.textContent = '[data-probe-three] > button { flex: 1 1 0 !important; min-width: 0 !important; }'
    document.head.append(tag)

    /** The label's natural single-line width, measured off-layout. */
    const naturalWidth = (label, element) => {
      const style = getComputedStyle(element)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (context === null) return null
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      return Math.ceil(context.measureText(label).width)
    }

    const report = []
    for (const dialogWidth of widths) {
      // Widen the card itself, which is what the footer is sized from.
      dialog.style.width = `${String(dialogWidth)}px`
      dialog.style.maxWidth = `${String(dialogWidth)}px`
      void dialog.getBoundingClientRect()
      const footerWidth = Math.round(footer.getBoundingClientRect().width)
      const entries = []
      for (const labels of candidates) {
        footer.replaceChildren()
        footer.setAttribute('data-probe-three', '')
        const clones = []
        for (const label of labels) {
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
          footer.append(clone)
          clones.push(clone)
        }
        void footer.getBoundingClientRect()
        entries.push({
          labels,
          buttons: clones.map(node => {
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            const width = Math.round(rect.width)
            const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
            const available = Math.round(width - padding)
            const natural = naturalWidth((node.textContent ?? '').trim(), node)
            return {
              label: (node.textContent ?? '').trim(),
              width,
              available,
              natural,
              fits: natural !== null && natural <= available,
            }
          }),
        })
      }
      report.push({ dialogWidth, footerWidth, entries })
    }
    footer.removeAttribute('data-probe-three')
    tag.remove()
    dialog.style.width = ''
    dialog.style.maxWidth = ''
    return { report }
  }, { candidates, widths })

  if (results.error !== undefined) {
    console.log(`无法测量: ${results.error}`)
  } else {
    for (const block of results.report) {
      console.log(`=== 对话框宽 ${block.dialogWidth}px（footer ${block.footerWidth}px）===`)
      for (const entry of block.entries) {
        const anyClipped = entry.buttons.some(b => !b.fits)
        const detail = entry.buttons.map(b => `${b.label}:${b.fits ? '✓' : '✗'}(${String(b.natural)}/${String(b.available)}px)`).join('  ')
        console.log(`  ${anyClipped ? '❌' : '✅'} ${JSON.stringify(entry.labels)}`)
        console.log(`      ${detail}`)
      }
      console.log('')
    }
  }
} finally {
  running.kill()
  await browser.close()
}
