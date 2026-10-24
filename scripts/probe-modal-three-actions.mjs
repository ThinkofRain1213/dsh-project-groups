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
 * checked against the live layout: a Range over its text node reports one rect per
 * rendered line (wrapping), and the button's own scroll width reports clipping.
 * The original footer children are put back afterwards, so the page is left as found.
 *
 * Labels are tested in the order they would appear, and reported per candidate so the
 * wording can be chosen against a number rather than a guess.
 *
 * Usage: node probe-modal-three-actions.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-modal-three-actions.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// `join` + an overridable port: the escaped-backslash path cannot resolve off Windows, and
// the fixed pair collided when two probes ran at once (or a stale server held the port).
const PROFILE_PORTS = { pg: 17840, official: 17841 }
const PORT = Number(process.env.DSH_PROBE_PORT ?? PROFILE_PORTS[profile])
if (!Number.isInteger(PORT)) {
  console.error(`unknown profile '${profile}'; supported: ${Object.keys(PROFILE_PORTS).join(', ')}`)
  process.exit(2)
}
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

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
// Created here, awaited inside the `try` below: awaiting it at the top level meant a boot
// timeout (or a browser launch failure) threw before `finally`, orphaning the host process
// with the port still bound.
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

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

try {
  const url = await boot
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
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

  // Candidate label sets, from shortest to the user's own wording. They are this probe's
  // input fixture, and the report prints them per row, so a stale set is visible in the
  // output rather than silent.
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
    // Anchored on the primitive's own `.footer` class first — the build hashes it but keeps
    // the local part, the same way `dismiss` matches `.mask`. The containment walk alone
    // stops at the first common ancestor, which is the footer only while the buttons are its
    // direct children: one wrapper would silently move the flex recipe (and every measured
    // number) onto the dialog body. Whichever anchor wins is validated and reported.
    const hasFooterClass = (node) => [...node.classList].some(name => name.toLowerCase().includes('footer'))
    const ancestors = []
    for (let node = buttons[0].parentElement; node !== null; node = node.parentElement) ancestors.push(node)
    const byClass = ancestors.find(hasFooterClass)
    const footer = byClass ?? ancestors.find(node => buttons.every(button => node.contains(button))) ?? null
    if (footer === null) return { error: 'no footer' }
    if (!buttons.every(button => footer.contains(button))) {
      return { error: 'footer candidate does not hold every action button' }
    }
    const footerSource = byClass === undefined ? 'containment walk' : 'footer class'
    // The real children are snapshotted and put back at the end: the old cleanup left the
    // live dialog holding dummy clones, so anything measured after this (and the user's own
    // view of the dialog) was reading a rebuilt footer.
    const originalChildren = [...footer.children]

    const template = buttons[0]
    const tag = document.createElement('style')
    tag.id = 'probe-three-actions'
    tag.textContent = '[data-probe-three] > button { flex: 1 1 0 !important; min-width: 0 !important; }'
    document.head.append(tag)

    /**
     * One button's label geometry, read off the live layout.
     *
     * This used to be reconstructed on a canvas from the computed font. That approximation
     * ignored letter-spacing and inline content, and a multi-name `font-family` stack can
     * fail the font shorthand parse — in which case `context.font` silently keeps the
     * PREVIOUS font and the number is meaningless. `fits` is the one metric this probe
     * produces, so it comes from the real element: a Range over the label's text node gives
     * one rect per rendered line, and the button's own scroll width says whether the text
     * was clipped instead of wrapped.
     * @param node - the cloned button.
     * @returns line count, widest line width, and whether the content overflows.
     */
    const labelGeometry = (node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      const text = walker.nextNode()
      if (text === null) return { lines: 0, natural: null, clipped: false }
      const range = document.createRange()
      range.selectNodeContents(text)
      const rects = [...range.getClientRects()]
      const natural = rects.length === 0 ? null : Math.round(Math.max(...rects.map(rect => rect.width)))
      return { lines: rects.length, natural, clipped: node.scrollWidth > node.clientWidth + 1 }
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
            const geometry = labelGeometry(node)
            return {
              label: (node.textContent ?? '').trim(),
              width,
              available,
              natural: geometry.natural,
              lines: geometry.lines,
              clipped: geometry.clipped,
              fits: geometry.natural !== null && geometry.lines <= 1 && !geometry.clipped
                && geometry.natural <= available + 1,
            }
          }),
        })
      }
      report.push({ dialogWidth, footerWidth, footerSource, entries })
    }
    footer.replaceChildren(...originalChildren)
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
      console.log(`=== 对话框宽 ${block.dialogWidth}px（footer ${block.footerWidth}px，锚点=${block.footerSource}）===`)
      for (const entry of block.entries) {
        const anyClipped = entry.buttons.some(b => !b.fits)
        const detail = entry.buttons.map(b => `${b.label}:${b.fits ? '✓' : '✗'}(${String(b.natural)}/${String(b.available)}px,${String(b.lines)}行${b.clipped ? ',被裁切' : ''})`).join('  ')
        console.log(`  ${anyClipped ? '❌' : '✅'} ${JSON.stringify(entry.labels)}`)
        console.log(`      ${detail}`)
      }
      console.log('')
    }
  }
} finally {
  child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
