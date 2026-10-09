/**
 * Does this plugin's settings card render on its own Plugin manager page, and
 * does it drive the New Session destination?
 *
 * Two separate claims are measured, because they fail differently:
 *
 * 1. **The card exists.** The Plugins page renders `plugins.bundle.config`
 *    between the description and the "included components" list, and it gates
 *    that whole section on the slot's own keys (`config-ledger.ts` projects them
 *    into `configured`). A registration whose `key` does not match the installed
 *    bundle name is silently not rendered — no error, no warning — so only
 *    driving the page proves the key is right.
 *
 * 2. **The card works.** Choosing an option writes the Host's stored destination
 *    and the shell's New Session button then files the Session accordingly. The
 *    probe asserts the destination through the UI and then measures the effect
 *    through the Host's assignment table, rather than trusting that a click
 *    landed.
 *
 * Usage: node probe-settings-card.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { installRowKeyHelpers } from './lib/row-key.mjs'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-settings-card.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = 17681
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** The seeded project's title, shared with the behaviour steps below. */
let alpha = ''

const child = spawn(exe, [BIN, '--profile', 'pg', '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout: ${out.slice(-300)}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (match !== null) { clearTimeout(timer); setTimeout(() => resolve(match[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

const origin = new URL(url).origin
const token = new URL(url).searchParams.get('token') ?? ''

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await installRowKeyHelpers(page)
const logs = []
page.on('console', (message) => { if (message.type() === 'error') logs.push(message.text()) })
page.on('pageerror', (error) => { logs.push(`pageerror: ${error.message}`) })

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
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

/** The stored global, read from the Host's own domain file. */
const domain = async () => {
  const text = await readFile(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
  const parsed = JSON.parse(text)
  return { global: parsed.global, assignments: parsed.tables.assignments ?? {}, projects: parsed.tables.projects ?? {} }
}

/**
 * The card's own subtree on the Plugins page.
 *
 * `[data-plugin-config]` is the section the page wraps a bundle's configuration
 * in; it is absent entirely when no entry claims the bundle's key.
 */
const card = () => page.locator('[data-plugin-config]').first()

/** The card's trigger pill, identified by the row title next to it. */
const pillar = () => card().locator('button[aria-haspopup="menu"]').first()

/** The Session the shell renders as the unstarted one. */
const blankSessionId = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-row-key^="session:"]')]
    .find(node => (node.textContent ?? '').includes('新会话'))
  return window.__sessionIdOf(row?.getAttribute('data-row-key'))
})

/** Where that Session is filed, tracked by identity (a blank Session is reused). */
const blankOwner = async () => {
  const id = await blankSessionId()
  if (id === null) return { id: null, owner: undefined }
  const { assignments, projects } = await domain()
  const record = assignments[id]
  return { id, owner: record === undefined ? undefined : projects[record.projectId]?.title }
}

/** Open the Plugins page and the project-groups bundle's own detail page. */
const openCard = async () => {
  await dismiss()
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  // The bundle's card in the list, then its detail page.
  //
  // Addressed by its **displayed** name, not by the package name: the Plugins list localizes the
  // entry, so `text=dsh-project-groups` matches nothing and this helper timed out on every run. It
  // was verified to fail identically on the commit before Z-9, so this is a pre-existing mismatch
  // with the current DSH rather than a consequence of that work — and it has to be fixed for any
  // card assertion to run at all.
  const entry = page.locator('[data-plugin-id="dsh-project-groups"]').or(page.getByText('项目分组', { exact: true })).first()
  await entry.click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()
}

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  const stamp = Date.now().toString(36)
  alpha = `甲${stamp}`

  // Seed one project through the sidebar so the destination has somewhere to go.
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(alpha)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
  await dismiss()

  // ── 1. The card renders on this plugin's own page. ──
  await openCard()
  check('the Plugins page renders a configuration section for this bundle',
    await card().count() > 0,
    `sections: ${await page.locator('[data-plugin-config]').count()}`)
  const cardText = (await card().innerText().catch(() => '')).replace(/\s+/g, ' ')
  console.log(`card text: ${JSON.stringify(cardText.slice(0, 200))}`)
  check('it carries this plugin\'s copy', cardText.includes('新会话落点'), cardText.slice(0, 80))
  check('and its trigger shows the stored destination',
    (await pillar().innerText().catch(() => '')).includes('未分组'),
    await pillar().innerText().catch(() => '(no pill)'))

  // ── 2. The menu opens with all three destinations, and the current one is marked. ──
  //
  // A missing card is the negative-control outcome: the remaining steps depend on
  // the card, so they are reported as skipped rather than throwing out of the run
  // with an unhelpful locator timeout.
  const cardPresent = await card().count() > 0
  if (!cardPresent) {
    console.log('SKIP  the card\'s behaviour — no configuration section rendered')
  } else {
    await runCardBehaviour()
  }

  console.log(`\nconsole errors: ${logs.length === 0 ? '(none)' : logs.slice(0, 5).join(' | ')}`)
} finally {
  child.kill()
  await browser.close()
}

/** Steps that need the card: the menu, the write, and the shell's button. */
async function runCardBehaviour() {
  await pillar().click()
  await page.waitForTimeout(900)
  const menu = page.getByRole('menu').first()
  check('the trigger opens a menu', await menu.count() > 0)
  const items = await menu.getByRole('menuitem').allInnerTexts()
  console.log(`menu items: ${JSON.stringify(items)}`)
  check('with all three destinations',
    items.length === 3 && items.join('|').includes('未分组')
      && items.join('|').includes('当前会话所在项目') && items.join('|').includes('最后活跃的会话所在项目'),
    JSON.stringify(items))

  // The native `<select>` the voice-input card uses renders its popup with the
  // operating system's colours, so it goes light on a dark theme. The Menu draws
  // its own themed surface instead — so the popup must not be the light fill a
  // native popup would be.
  const surface = await menu.evaluate((node) => {
    const findFill = (element) => {
      const own = getComputedStyle(element).backgroundColor
      if (own !== 'rgba(0, 0, 0, 0)' && own !== 'transparent') return own
      for (const child of element.children) {
        const found = findFill(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    return { fill: findFill(node), scheme: getComputedStyle(document.documentElement).colorScheme }
  })
  console.log(`menu surface: ${JSON.stringify(surface)}`)
  check('the popup is themed rather than the OS light fill',
    surface.fill !== undefined && surface.fill !== 'rgb(255, 255, 255)',
    JSON.stringify(surface))

  // ── 3. Choosing "recent" is stored and shown. ──
  await menu.getByRole('menuitem', { name: '最后活跃的会话所在项目' }).click()
  await page.waitForTimeout(2500)
  const afterPick = await domain()
  console.log(`stored global: ${JSON.stringify(afterPick.global)}`)
  check('choosing an option stores it on the Host',
    afterPick.global?.newSessionTarget === 'recent', JSON.stringify(afterPick.global))
  check('and the trigger shows the new choice',
    (await pillar().innerText().catch(() => '')).includes('最后活跃'), await pillar().innerText().catch(() => '(no pill)'))
  check('and the project order survived the write',
    Object.keys(afterPick.projects).length === 1, JSON.stringify(Object.keys(afterPick.projects)))

  // ── 4. The choice actually drives the shell's New Session button. ──
  await dismiss()
  await page.locator('button[aria-label="新建会话"]').first().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  const filed = await blankOwner()
  console.log(`after the top New Session with "recent": ${JSON.stringify(filed)}`)
  check('the stored destination drives the New Session button',
    filed.owner === alpha, JSON.stringify(filed))

  // ── 5. Switching back to Ungrouped takes effect too. ──
  await openCard()
  await pillar().click()
  await page.waitForTimeout(900)
  await page.getByRole('menu').first().getByRole('menuitem', { name: '未分组' }).click()
  await page.waitForTimeout(2500)
  check('switching back stores Ungrouped',
    (await domain()).global?.newSessionTarget === 'ungrouped', JSON.stringify((await domain()).global))
  await dismiss()
  await page.locator('button[aria-label="新建会话"]').first().click({ force: true })
  await page.waitForTimeout(5000)
  const backToUngrouped = await blankOwner()
  console.log(`after the top New Session with "ungrouped": ${JSON.stringify(backToUngrouped)}`)
  check('and Ungrouped files the Session under nothing',
    backToUngrouped.owner === undefined, JSON.stringify(backToUngrouped))

  // ── 6. The popup stays themed on a dark theme. ──
  //
  // This is the defect the native `<select>` in the voice-input card has: its
  // popup is drawn by the operating system and ignores CSS, so it goes light on
  // a dark theme. The Menu draws its own surface, so its fill must follow the
  // theme. Measured in both schemes because a fill that is merely "not white"
  // proves nothing in a run that happened to be light.
  const surfaceReading = async () => {
    await openCard()
    await pillar().click()
    await page.waitForTimeout(900)
    const node = page.getByRole('menu').first()
    const reading = await node.evaluate((element) => {
      const findFill = (current) => {
        const own = getComputedStyle(current).backgroundColor
        if (own !== 'rgba(0, 0, 0, 0)' && own !== 'transparent') return own
        for (const child of current.children) {
          const found = findFill(child)
          if (found !== undefined) return found
        }
        return undefined
      }
      return { fill: findFill(element), scheme: getComputedStyle(document.documentElement).colorScheme }
    })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    return reading
  }

  const light = await surfaceReading()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(1200)
  const dark = await surfaceReading()
  await page.emulateMedia({ colorScheme: null })
  console.log(`popup fill — light: ${JSON.stringify(light)}, dark: ${JSON.stringify(dark)}`)
  check('the popup fill changes with the theme',
    light.fill !== undefined && dark.fill !== undefined && light.fill !== dark.fill,
    JSON.stringify({ light, dark }))
  check('and neither is the OS light popup fill',
    light.fill !== 'rgb(255, 255, 255)' && dark.fill !== 'rgb(255, 255, 255)',
    JSON.stringify({ light, dark }))

  // ── 7. The injection preview. ──
  //
  // Z-9: the card shows what the plugin injects, before the user has to open a Session and read
  // its logs. Two things about it are worth pinning, because both are easy to break silently:
  //
  //   - the main display must be **resident**, not a disclosure. A collapsed answer is not an
  //     answer, and "it is there but folded" would still pass a naive text search.
  //   - the bracketed placeholders must stand for the user's data **only**. `"Ungrouped"` is a
  //     constant in the renderer, so bracketing it would claim it varies — the first draft of this
  //     panel did exactly that.
  await openCard()
  const panel = card().locator('text=当前注入内容').first()
  check('7) 注入预览面板存在', await panel.count() > 0)
  /**
   * The panel's own text.
   *
   * Scoped by the panel's own class rather than the whole card: the card also carries every
   * switch's copy and every dictionary entry it renders, so a full-card string is not evidence
   * about the panel — and a failure would print the wrong thing to look at.
   */
  const panelText = async () => (await card()
    .locator('[class*="injectionPanel"]').first().innerText()).replace(/\s+/g, ' ')
  const shown = await panelText()
  check('7) 主展示含项目名占位符（带引号，与真实语法一致）',
    shown.includes('project name "[项目名称]"'), shown.slice(0, 260))
  check('7) 主展示含目录与链接占位符',
    shown.includes('[目录 1]') && shown.includes('[链接 1]'),
    shown.slice(0, 300))

  /** The 注入项目信息 switch, by name. */
  const masterSwitch = page.getByRole('switch', { name: '注入项目信息' }).first()
  /** The 注入项目文档 switch, by name. */
  const docSwitch = page.getByRole('switch', { name: '注入项目文档' }).first()

  // The document segment joins only with both switches on; the declaration paragraph tracks it.
  await docSwitch.click()
  await page.waitForTimeout(1200)
  const withDoc = await panelText()
  check('7) 文档开关打开后，声明段列出 work document',
    withDoc.includes('`work document`'), withDoc.slice(0, 260))
  check('7) 文档开关打开后，主展示含文档路径占位符',
    withDoc.includes('Project document: [文档路径]'), withDoc.slice(0, 320))
  await docSwitch.click()
  await page.waitForTimeout(1200)
  const withoutDoc = await panelText()
  check('7) 文档开关关闭后，主展示不再含文档段',
    !withoutDoc.includes('Project document: '), withoutDoc.slice(0, 260))

  // The diffs start collapsed: their variant labels exist in the dictionary but must not be
  // rendered until a group is opened.
  check('7) 分块差分默认全部折叠（组标题在场）',
    withoutDoc.includes('owning project 段') && withoutDoc.includes('related links 段'),
    withoutDoc.slice(0, 320))
  check('7) 折叠时组内的形态标签不可见',
    !withoutDoc.includes('有归属项目') && !withoutDoc.includes('只有一条'),
    withoutDoc.slice(0, 320))

  // Opening one group reveals only that group.
  await card().locator('text=related links 段').first().click()
  await page.waitForTimeout(600)
  const linksOpen = await panelText()
  check('7) 点开后该组展开，出现形态标签',
    linksOpen.includes('没有链接') && linksOpen.includes('多条'), linksOpen.slice(0, 420))
  check('7) 展开后其它组仍折叠（owning 组标签仍不可见）',
    !linksOpen.includes('有归属项目'), linksOpen.slice(0, 420))
  check('7) 空链接那一项说明「整段不渲染」',
    linksOpen.includes('整段不渲染'), linksOpen.slice(0, 420))

  // The assertion that pins the placeholder rule: a constant gets no brackets.
  //
  // Read **after opening the owning group**, because that is the only place `"Ungrouped"` is ever
  // rendered — the diff variant carrying it is collapsed by default. Asserting it against the
  // default view passed no matter what the preview did, which is how this assertion was first
  // written and why reverse control 2 did not fail.
  await card().locator('text=owning project 段').first().click()
  await page.waitForTimeout(600)
  const owningOpen = await panelText()
  check('7) 未分组一项保留真实常量文本（"Ungrouped" 不加方括号）',
    owningOpen.includes('"Ungrouped"') && !owningOpen.includes('"[未分组]"'),
    owningOpen.slice(0, 420))

  // The diff section's shape, measured rather than described.
  //
  // ⚠️ Measured with every group **collapsed**. An expanded group appends its `.injectionDiffBody`
  // below the button, so that group's box would extend past the label and its "air below" would
  // swallow the whole body — the measurement would be of the body, not of the row. The two
  // assertions above leave `related links` and `owning project` open, so both are closed first.
  await card().locator('text=related links 段').first().click()
  await page.waitForTimeout(400)
  await card().locator('text=owning project 段').first().click()
  await page.waitForTimeout(400)
  const collapsed = await panelText()
  check('7) 测量前所有分组已收起（形态标签不可见）',
    !collapsed.includes('有归属项目') && !collapsed.includes('没有链接'),
    collapsed.slice(0, 320))

  // ## Why these are geometric, and what each one is guarding
  //
  // Every string assertion above passed while the geometry was wrong, so the shape is measured
  // directly. Two defects are being pinned, and both are invisible to text:
  //
  //   1. the panel's one-time `gap: 8px` landed *below* each diff row but not above it (the row's
  //      own `padding: 8px 0` was already there), so a label sat 8px from its neighbour above and
  //      16px from the one below;
  //   2. three dividers plus the panel's own bottom border made the last row indistinguishable from
  //      a fourth, empty row, and left that row 8px deeper than the ones above it.
  //
  // The rows are **plain rows**: no enclosing surface, and no divider between them. What is asserted
  // is that the rows exist, that nothing sits between them, that no divider came back, and that each
  // label stays centred in its own button.
  const shape = await card().evaluate((root) => {
    const panel = root.querySelector('[class*="injectionPanel"]')
    if (panel === null) return null
    // Descendant search, not `panel.children`: the panel also holds the heading and the main display.
    // Matching must require a direct `button`, which is what distinguishes a row from any other
    // element whose class merely contains "injectionDiff".
    const groups = [...panel.querySelectorAll('[class*="injectionDiff"]')]
      .filter((el) => el.querySelector(':scope > button') !== null)
    if (groups.length === 0) return { missing: 'groups' }

    /** The button's content box: its rect minus the padding its own rule declares. */
    const contentBox = (button) => {
      const r = button.getBoundingClientRect()
      const cs = getComputedStyle(button)
      return {
        top: r.top + Number.parseFloat(cs.paddingTop),
        bottom: r.bottom - Number.parseFloat(cs.paddingBottom),
      }
    }

    const pr = panel.getBoundingClientRect()
    const rects = groups.map((g) => g.getBoundingClientRect())
    const rows = groups.map((group) => {
      const box = contentBox(group.querySelector(':scope > button'))
      const g = group.getBoundingClientRect()
      return {
        over: Math.round(box.top - g.top),
        under: Math.round(g.bottom - box.bottom),
      }
    })
    // The rows are flush: the only spacing between two labels is their own padding, so a positive
    // number here is a re-added `gap` or margin — the exact defect this section was written for.
    const boxGaps = rects.slice(0, -1).map((r, i) => Math.round(rects[i + 1].top - r.bottom))
    // Full-width **dividers**: an element with a top or bottom border but **no** left/right border.
    // That exclusion is the whole point — a four-sided box (the injected block's `border`) has top
    // and bottom borders too, and counting those made this assertion fail the moment a second
    // full-width box existed. It also excluded the panel itself (`querySelectorAll('*')` never
    // returns the context element), so the panel is measured explicitly.
    const panelWidth = Math.round(pr.width)
    const isWide = (el) => Math.round(el.getBoundingClientRect().width) >= panelWidth - 2
    const dividers = []
    for (const el of panel.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      const vb = Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth)
      const hb = Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.borderRightWidth)
      if (vb <= 0 || hb > 0) continue
      if (isWide(el)) dividers.push(el.className)
    }
    const panelCS = getComputedStyle(panel)
    const panelDivider = (Number.parseFloat(panelCS.borderTopWidth)
      + Number.parseFloat(panelCS.borderBottomWidth)) > 0
    const first = panel.firstElementChild
    const title = panel.querySelector('[class*="injectionDiffTitle"]')
    const firstRow = groups[0]
    return {
      rows,
      boxGaps,
      dividers,
      panelDivider,
      // The heading's trailing gap now lives on the first row's **margin**, so this is measured
      // between the heading's box and the first row's box.
      headingToFirstRow: title === null ? null
        : Math.round(firstRow.getBoundingClientRect().top - title.getBoundingClientRect().bottom),
      // No enclosing surface may exist: this is the property that separates this shape from the
      // block alternative, and its return would silently undo the design.
      hasEnclosingSurface: [...panel.querySelectorAll('[class*="injectionDiffList"]')].length,
      panelGap: getComputedStyle(panel).rowGap,
      panelPadTop: Math.round(Number.parseFloat(getComputedStyle(panel).paddingTop)),
      topAir: first === null ? null : Math.round(first.getBoundingClientRect().top - pr.top),
      groupCount: groups.length,
    }
  })

  // 1. No enclosing surface. The block alternative would put a filled, bordered container around the
  // rows; this shape deliberately does not, and a leftover class name is exactly how it would come
  // back by accident.
  check('7) 差分区没有外层容器（行直接属于面板）',
    shape !== null && shape.hasEnclosingSurface === 0,
    JSON.stringify({ hasEnclosingSurface: shape?.hasEnclosingSurface }))

  // 2. No divider anywhere inside the panel, and the only horizontal rule is the panel's own bottom
  // border. A hairline between rows was the reported defect: the last row's line and this border were
  // the same weight, so the stack read as a fourth, empty row.
  check('7) 行之间没有分割线（只剩面板底边一条）',
    shape !== null && shape.dividers !== undefined && shape.panelDivider === true
    && shape.dividers.length === 0,
    JSON.stringify({ dividers: shape?.dividers, panelDivider: shape?.panelDivider }))

  // 3. No `gap` or margin between the rows: a re-added one brings the 8px asymmetry straight back.
  check('7) 分组之间没有额外间隙（未再加 gap/margin）',
    shape !== null && shape.boxGaps !== undefined && shape.boxGaps.length > 0
    && shape.boxGaps.every((g) => Math.abs(g) <= 1),
    JSON.stringify({ panelGap: shape?.panelGap, boxGaps: shape?.boxGaps }))

  // 4. Every row's label is vertically centred in its button. With no block to carry padding and no
  // divider to hide an asymmetry, this symmetry is the only thing keeping the spacing even, and it is
  // what makes the hover fills line up with the labels.
  check('7) 每行标签在其按钮内上下居中（±1px）',
    shape !== null && shape.rows !== undefined && shape.rows.length > 0
    && shape.rows.every((r) => r.over !== null && r.under !== null && Math.abs(r.over - r.under) <= 1),
    JSON.stringify({ rows: shape?.rows }))

  // 5. The heading starts the section and the rows follow it closely: the gap is the heading's own
  // `margin-top` air echoed below it, and the panel's top air matches the first heading's.
  check('7) 标题与第一行相距 8px，且面板顶部留白 16px',
    shape !== null && shape.headingToFirstRow !== null
    && Math.abs(shape.headingToFirstRow - 8) <= 1 && shape.topAir === 16,
    JSON.stringify({ headingToFirstRow: shape?.headingToFirstRow, topAir: shape?.topAir }))

  // 6. The hover fill is the rows' **only** affordance now that neither a divider nor a block marks
  // them. That is the trade this shape makes, and a regression to a colour-only hover would leave the
  // rows looking inert with nothing else to fail — every other assertion here still passes.
  //
  // Read from the stylesheet rather than simulated: a synthetic class proves the *token* resolves,
  // not that the `:hover` rule exists, and the rule is exactly what would be deleted by mistake.
  const hover = await card().evaluate((root) => {
    const panel = root.querySelector('[class*="injectionPanel"]')
    const button = panel?.querySelector('[class*="injectionDiff"] > button')
    const own = button?.className ?? ''
    const hits = []
    for (const sheet of [...document.styleSheets]) {
      let rules
      try { rules = [...sheet.cssRules] } catch { continue }
      for (const rule of rules) {
        const text = String(rule.cssText)
        if (!text.includes(':hover')) continue
        // The hashed class name is the only stable link back to our rule from inside the page.
        if (own !== '' && text.includes(own.split(' ')[0])) hits.push(text.slice(0, 220))
      }
    }
    return { own, hits }
  })
  check('7) 分组行有悬停底色（无块无线时可点击性的唯一提示）',
    hover.hits.some((t) => t.includes('background')), JSON.stringify(hover))

  // The master switch off: the panel stays, and says nothing is injected.
  await masterSwitch.click()
  await page.waitForTimeout(1200)
  const offText = await panelText()
  check('7) master 关闭后面板仍常驻（标题在场）',
    offText.includes('当前注入内容'), offText.slice(0, 240))
  check('7) master 关闭后说明不注入任何内容',
    offText.includes('不向请求注入任何内容'), offText.slice(0, 280))
  check('7) master 关闭后不再渲染注入块',
    !offText.includes('project name "'), offText.slice(0, 280))
  check('7) master 关闭后没有分块差分',
    !offText.includes('各状态下的分块差异'), offText.slice(0, 280))
  await masterSwitch.click()
  await page.waitForTimeout(1200)

  // The validate switch moved above the injection chain, and still works where it now sits.
  const cardOrder = await card().evaluate((root) => {
    const text = root.innerText
    return ['开启http(s)://校验', '注入项目信息', '注入项目文档'].map(label => text.indexOf(label))
  })
  check('7) 校验开关排在「注入项目信息」之前',
    cardOrder[0] !== -1 && cardOrder[1] !== -1 && cardOrder[0] < cardOrder[1],
    JSON.stringify(cardOrder))
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)