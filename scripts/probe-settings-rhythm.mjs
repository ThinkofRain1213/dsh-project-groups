/**
 * Measure the settings card's vertical rhythm on a real instance.
 *
 * ## What this adds over `verify-settings-rhythm.mjs`
 *
 * That script pins the four declared values by reading the stylesheet. This one
 * proves they **compose** into the intended gaps: 12px of padding on two
 * neighbouring blocks is 24px only if nothing else contributes, and the negative
 * margins only produce 16px at the ends if they actually apply to the right
 * element. A declared value can be right while the rendered gap is wrong — the
 * `.section > :first-child` selector is exactly that risk.
 *
 * The numbers it asserts, from the spec:
 *
 *   two neighbouring rows         12 + 12 = 24px
 *   title → its description       6px
 *   group heading → its content   6px
 *   card top → first content      16px  (section 16 − 12 + row 12)
 *   across a rule                 32px  (section 16 + section 16)
 *
 * Usage: node probe-settings-rhythm.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-settings-rhythm.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = Number(process.env.DSH_PROBE_PORT ?? 17681)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const BUNDLE_DISPLAY_NAME = '项目分组'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

function boot() {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [BIN, '--profile', 'pg', '--port', String(PORT), '--no-open'], {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    let timer
    const fail = (error) => {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      reject(error)
    }
    timer = setTimeout(() => fail(new Error(`timed out booting: ${redactToken(out.slice(-400))}`)), 120_000)
    child.on('error', (error) => fail(new Error(`spawn failed: ${error.message}`)))
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      if (settled) return
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) {
        settled = true
        clearTimeout(timer)
        setTimeout(() => resolve({ child, url: match[1] }), 3000)
      }
    })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('exit', (code) => { fail(new Error(`exited early with ${code}: ${redactToken(out.slice(-400))}`)) })
  })
}

async function stop(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => { child.once('exit', resolve) })
  // A signal, not just a wait: without it the process survives `process.exit` and
  // holds this hard-coded port, so the next run fails at boot with an unrelated
  // message.
  child.kill()
  const released = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ])
  if (released) await new Promise(resolve => setTimeout(resolve, 500))
  else console.log('  （警告：进程 10s 内没有退出，端口可能仍被占用）')
}

/**
 * Measure the geometry the card's rhythm is made of.
 *
 * Runs in the page: reads boxes and computed styles, returns plain numbers so the
 * assertions below stay in Node where a failure prints a readable diff.
 * @returns the measurements, or `null` with a reason when the card is absent.
 */
const measure = () => page.evaluate(() => {
  const root = document.querySelector('[data-plugin-config]')
  if (root === null) return { reason: 'no [data-plugin-config]' }

  /** All blocks that carry the row/group padding, in document order. */
  const sections = [...root.querySelectorAll('div')].filter(node => {
    const style = getComputedStyle(node)
    return style.paddingTop === '16px' && style.paddingBottom === '16px'
      && style.display === 'flex' && style.flexDirection === 'column'
      && (node.firstElementChild !== null)
      // `.section` is the only 16px-padded flex column that also carries a
      // negative top margin on its first child.
      && getComputedStyle(node.firstElementChild).marginTop === '-12px'
  })
  if (sections.length === 0) return { reason: 'no .section found' }

  const rows = sections[0] === undefined ? [] : [...sections[0].children]
    // `.row` and nothing else: a bare `paddingTop === '12px'` also matched inner
    // wrappers, and two of those can be the same box's children — which measured a
    // gap of 0 and looked like a rhythm bug. Requiring a direct child of the
    // section plus a horizontal flex layout pins the actual rows.
    .filter(node => {
      const style = getComputedStyle(node)
      return style.paddingTop === '12px'
        && style.display === 'flex'
        && style.flexDirection !== 'column'
    })
  const first = rows[0]
  const second = rows[1]
  if (first === undefined || second === undefined) return { reason: 'need two rows', sectionCount: sections.length }

  const firstStyle = getComputedStyle(first)
  const secondStyle = getComputedStyle(second)
  const sectionStyle = getComputedStyle(sections[0])

  // Title → description inside the first row.
  const rowText = first.querySelector('div > div')
  let titleGap = null
  if (rowText !== null) {
    const kids = [...rowText.children]
    if (kids.length >= 2) {
      const a = kids[0].getBoundingClientRect()
      const b = kids[1].getBoundingClientRect()
      titleGap = Math.round(b.top - a.bottom)
    }
  }

  // Card top → first row's content: the distance from the section's own top edge
  // to the first row's content box.
  const sectionRect = sections[0].getBoundingClientRect()
  const firstRect = first.getBoundingClientRect()
  const cardTopToContent = Math.round(
    firstRect.top - sectionRect.top + parseFloat(firstStyle.paddingTop),
  )

  // Content-to-content between two rows. `getBoundingClientRect` includes each
  // row's own padding, so the measured gap is exactly the sum of the two
  // paddings — 12 + 12 when the rhythm is right.
  // Content-to-content between two rows.
  //
  // `getBoundingClientRect` **includes padding**, so two adjacent rows' boxes touch
  // exactly (no margin between them) and the raw box gap is always 0 — measuring
  // that would report a rhythm bug on a correct card. The content gap is the first
  // row's bottom padding plus the second row's top padding.
  const rowGapComputed = Math.round(
    parseFloat(firstStyle.paddingBottom) + parseFloat(secondStyle.paddingTop),
  )

  // An independent geometric witness for the same gap: the distance between the two
  // rows' first text lines should be that gap plus the first line's own height. This
  // is what catches a padding that is declared but cancelled by something else —
  // the sum above cannot, because it reads the declarations back.
  //
  // The line is `.rowText`'s first child (the row's title). Picking "the row's first
  // div" instead walks into the flex cell, whose box spans the whole row — that
  // measured a whole row height and reported the gap as 68.
  const lineOf = (row) => {
    const cell = row.querySelector('div')
    const text = cell?.firstElementChild ?? null
    return text === null ? null : text.getBoundingClientRect()
  }
  const lineA = lineOf(first)
  const lineB = lineOf(second)
  const lineHeight = lineA === null ? null : Math.round(lineA.height)
  const lineToLine = lineA === null || lineB === null ? null : Math.round(lineB.top - lineA.top)
  // Diagnostics: when the gap is 0 the two picked nodes are nested rather than
  // siblings, and printing their class names is what tells those apart.
  const describe = node => `${node.tagName.toLowerCase()}.${(node.className ?? '').toString().slice(0, 40)}`
  const childrenOfSection = [...sections[0].children].map(node => ({
    name: describe(node),
    top: Math.round(node.getBoundingClientRect().top),
    bottom: Math.round(node.getBoundingClientRect().bottom),
    padTop: getComputedStyle(node).paddingTop,
    marginTop: getComputedStyle(node).marginTop,
    marginBottom: getComputedStyle(node).marginBottom,
  }))

  // The group's heading → its content. Same witness shape as the row gap: the
  // heading's box bottom to the next child's box top, with neither carrying padding
  // of its own, so the raw distance IS the gap.
  const groups = [...sections[0].children]
    .filter(node => getComputedStyle(node).flexDirection === 'column' && node.children.length >= 2)
  const group = groups[0] ?? null
  let groupGap = null
  if (group !== null) {
    const kids = [...group.children]
    groupGap = Math.round(
      kids[1].getBoundingClientRect().top - kids[0].getBoundingClientRect().bottom,
    )
  }

  // Cross-rule distance, for EVERY rule on the card.
  //
  // A rule costs no space of its own, so the content-to-content distance across it
  // is the padding above plus the padding below. When each side belongs to its own
  // `.section` that is 16 + 16 = 32. A rule that ends up *inside* one section gets
  // only the neighbouring blocks' 12 + 12 = 24 instead, which makes one line in a
  // three-line card visibly tighter than the other two — the exact "two densities"
  // problem this change exists to remove.
  const ruleGaps = [...root.querySelectorAll('[role="separator"]')].map((node) => {
    const previous = node.previousElementSibling
    const next = node.nextElementSibling
    if (previous === null || next === null) return { reason: 'rule without both neighbours' }
    const before = getComputedStyle(previous).paddingBottom
    const after = getComputedStyle(next).paddingTop
    return {
      gap: Math.round(parseFloat(before) + parseFloat(after)),
      before,
      after,
      beforeTag: describe(previous),
      afterTag: describe(next),
    }
  })

  // The card's own bottom edge: the gap from the last block's *content* to the
  // section's bottom edge. The block's box still has its own 12px padding inside
  // it — the negative margin pulled the *box* down, not the padding away — so the
  // content edge is the box's bottom minus that padding. Expect 16: the section's
  // padding with the block's already cancelled by `:last-child`.
  const lastSection = sections[sections.length - 1]
  const lastSectionRect = lastSection.getBoundingClientRect()
  const lastChild = lastSection.lastElementChild
  const cardBottomToContent = lastChild === null ? null : Math.round(
    lastSectionRect.bottom - lastChild.getBoundingClientRect().bottom
      + parseFloat(getComputedStyle(lastChild).paddingBottom),
  )

  return {
    cardBottomToContent,
    ruleGaps,
    sectionCount: sections.length,
    rowCount: rows.length,
    sectionTop: Math.round(sectionRect.top),
    sectionHeight: Math.round(sectionRect.height),
    sectionDisplay: sectionStyle.display,
    sectionFlex: sectionStyle.flexDirection,
    rowPaddingTop: firstStyle.paddingTop,
    rowPaddingBottom: firstStyle.paddingBottom,
    sectionPaddingTop: sectionStyle.paddingTop,
    firstChildMarginTop: getComputedStyle(sections[0].firstElementChild).marginTop,
    rowGapComputed,
    groupGap,
    lineHeight,
    lineToLine,
    rowA: describe(first),
    rowB: describe(second),
    sectionChildren: childrenOfSection,
    rowATop: Math.round(first.getBoundingClientRect().top),
    rowABottom: Math.round(first.getBoundingClientRect().bottom),
    rowBTop: Math.round(second.getBoundingClientRect().top),
    titleGap,
    cardTopToContent,
  }
})

let browser
let page
let instance
try {
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: 'pg' })
  if (prepared.problem !== undefined) {
    console.error(`无法准备探针环境：${prepared.problem}`)
    process.exit(2)
  }

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  instance = await boot()
  await page.goto(instance.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(2500)

  await dismissModals(page)
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismissModals(page)
  const entry = page.locator('[data-plugin-id="dsh-project-groups"]')
    .or(page.getByText(BUNDLE_DISPLAY_NAME, { exact: true })).first()
  await entry.click({ force: true })
  await page.waitForTimeout(2500)
  await dismissModals(page)

  const m = await measure()
  console.log(`测量结果：${JSON.stringify(m)}`)
  // The section count is the precondition for every measurement below, so its
  // failure is reported on its own and the rest are skipped with a named reason —
  // wrapping all ten in one `if` collapsed a real diagnostic into a single FAIL
  // with no hint of what went wrong.
  const measured = typeof m.rowPaddingTop === 'string'
  check('设置卡渲染出来且找到 section', m.sectionCount >= 3, String(m.sectionCount))
  if (!measured) {
    console.log(`SKIP  其余测量——${String(m.reason ?? 'card did not measure')}`)
  } else {
    check('行 padding-top 是 12px', m.rowPaddingTop === '12px', m.rowPaddingTop)
    check('行 padding-bottom 是 12px', m.rowPaddingBottom === '12px', m.rowPaddingBottom)
    check('section padding-top 是 16px', m.sectionPaddingTop === '16px', m.sectionPaddingTop)
    check('首块被负边距吃掉 12px', m.firstChildMarginTop === '-12px', m.firstChildMarginTop)
    // The composed gaps. These are the numbers the spec actually promises; the
    // declared values above only add up to them if nothing else contributes.
    check('相邻两行内容相距 24px', m.rowGapComputed === 24, `${String(m.rowGapComputed)}px`)
    // The geometric witness, measured from the layout rather than from the
    // declarations: row A's box ends where row B's begins (adjacent flex items with
    // no margin), so the visible space between their *content* is A's bottom padding
    // plus B's top padding. Computed from the boxes, this catches a padding that is
    // declared but cancelled — the sum above cannot, because it reads them back.
    //
    // Expected 68px from title-top to title-top: title 20 + description gap 6 +
    // description 18 + the 24px between the rows.
    check('两行标题的纵向间距 = 内容 44 + 间隔 24',
      m.lineToLine === 68, `实测 ${String(m.lineToLine)}px（期望 68）`)
    check('行标题 → 说明 是 6px', m.titleGap === 6, `${String(m.titleGap)}px`)
    // The group's own gap, measured from the layout. This is the assertion the
    // static check cannot make: it pins the declaration, while this proves the
    // declared 6px is what the renderer actually put between the heading and its
    // content. Without it, a gap changed to 8px passed every other check.
    check('组标题 → 组内容 是 6px', m.groupGap === 6, `${String(m.groupGap)}px`)
    // Every line on the card must be the same distance from the content it sits
    // between. A line that lands inside one section gets 12 + 12 instead of
    // 16 + 16, so this is the assertion that catches a mis-nested section — the
    // failure mode the static check cannot see at all.
    const gaps = m.ruleGaps ?? []
    check('分隔线两侧各 16px（共 32px）',
      gaps.length > 0 && gaps.every(entry => entry.gap === 32),
      JSON.stringify(gaps))
    check('卡片顶 → 首个内容 是 16px', m.cardTopToContent === 16, `${String(m.cardTopToContent)}px`)
    check('卡片底 → 最后内容 是 16px', m.cardBottomToContent === 16, `${String(m.cardBottomToContent)}px`)
  }
} finally {
  if (instance?.child !== undefined && instance.child.exitCode === null) await stop(instance.child)
  if (browser !== undefined) await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
