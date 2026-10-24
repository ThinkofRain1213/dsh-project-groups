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
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { redactToken } from './lib/redact.mjs'

/**
 * The bundle's displayed name on the Plugins page.
 *
 * Addressed by its **displayed** name, not the package name: the list localizes the entry,
 * so `text=dsh-project-groups` matches nothing and `openCard` timed out on every run. Its
 * own constant because a copy change is exactly what silently breaks every card assertion.
 */
const BUNDLE_DISPLAY_NAME = '项目分组'
/** The card's own heading copy — what proves the config section is OURS. */
const CARD_COPY = '新会话落点'
/** The three destinations the card offers. */
const DEST_UNGROUPED = '未分组'
const DEST_RECENT = '最后活跃的会话所在项目'
const DEST_CURRENT = '当前会话所在项目'
/** The stored `newSessionTarget` each destination writes. */
const TARGET_RECENT = 'recent'
const TARGET_UNGROUPED = 'ungrouped'
/** The label the shell renders for the unstarted Session. */
const BLANK_SESSION_LABEL = '新会话'
/** The two switches the card renders; their order is asserted in step 6b. */
const SWITCH_VALIDATE = '开启http(s)://校验'
const SWITCH_INJECT_INFO = '注入项目信息'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-settings-card.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

// `join` rather than a hand-written `\\` path (the literal only worked on Windows), and an
// overridable port so a collision is fixable without editing the file.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17681)
const PROFILE = process.env.DSH_PROBE_PROFILE ?? 'pg'
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** The seeded project's title, shared with the behaviour steps below. */
let alpha = ''

// 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
// 进程存活但从不监听端口 —— 那时下面这行 spawn 等到的只是一条误导性的超时。
const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: PROFILE })
if (prepared.problem !== undefined) {
  console.error(`无法准备探针环境：${prepared.problem}`)
  process.exit(2)
}
const child = spawn(exe, [BIN, '--profile', PROFILE, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
// The boot await and `chromium.launch()` sit outside the try/finally that kills this child, so
// a boot timeout or a failed launch would orphan it (and leave the port bound). These are the
// fallback for that window; the boot-timeout path also kills explicitly.
const killChild = () => { try { child.kill() } catch { /* already gone */ } }
process.once('exit', killChild)
process.once('SIGINT', () => { killChild(); process.exit(130) })
/** Append a chunk to the retained boot log. */
const appendLog = (chunk) => { out += String(chunk) }
const bootUrl = async () => {
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        killChild()
        reject(new Error(`boot timeout: ${redactToken(out.slice(-300))}`))
      }, 120_000)
      // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
      // stdout, so without this handler the promise stayed pending until the 120 s timeout and
      // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
      // the process outright.
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`spawn failed for ${exe}: ${error.message}`))
      })
      // An early exit (bad args, the port already bound, a crash) also never prints a URL.
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`dsh exited before printing a URL (code=${String(code)}, signal=${String(signal)}): ${redactToken(out.slice(-300))}`))
      })
      child.stdout.on('data', (chunk) => {
        appendLog(chunk)
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
        if (match !== null) { clearTimeout(timer); setTimeout(() => resolve(match[1]), 3000) }
      })
      child.stderr.on('data', appendLog)
    })
  } catch (error) {
    killChild()
    throw error
  }
}

let browser
let page
const logs = []

/**
 * Read a popup's effective background fill by walking to the first painted descendant.
 *
 * Written with no outer references so its own source can be injected into `page.evaluate`
 * (see `FIND_FILL_SOURCE`). The walk used to be written out twice — once in step 2, once in
 * `surfaceReading` with the parameter renamed — and those two readings are compared against
 * each other, so a divergence there would be silently wrong rather than merely stale.
 * @param node - the popup element.
 * @returns the first non-transparent background colour, or undefined.
 */
function FIND_FILL(node) {
  const own = getComputedStyle(node).backgroundColor
  if (own !== 'rgba(0, 0, 0, 0)' && own !== 'transparent') return own
  for (const child of node.children) {
    const found = FIND_FILL(child)
    if (found !== undefined) return found
  }
  return undefined
}

/** {@link FIND_FILL} as source text, for injection into a `page.evaluate` body. */
const FIND_FILL_SOURCE = `(${String(FIND_FILL)})`

/**
 * Measure a popup's fill and the document's colour scheme in one page-side read.
 *
 * The walk is injected as source text rather than re-written inline: `page.evaluate` runs the
 * function's own text in the page, where a closure over {@link FIND_FILL} would not exist.
 * @param locator - the popup locator.
 * @returns a promise for `{ fill, scheme }`.
 */
const measureSurface = (locator) => locator.evaluate(
  new Function('node', `const FIND_FILL = ${FIND_FILL_SOURCE}; return { fill: FIND_FILL(node), scheme: getComputedStyle(document.documentElement).colorScheme }`),
)

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

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
const blankSessionId = () => page.evaluate((blankLabel) => {
  const row = [...document.querySelectorAll('[data-row-key^="session:"]')]
    .find(node => (node.textContent ?? '').includes(blankLabel))
  return window.__sessionIdOf(row?.getAttribute('data-row-key'))
}, BLANK_SESSION_LABEL)

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
  const entry = page.locator('[data-plugin-id="dsh-project-groups"]').or(page.getByText(BUNDLE_DISPLAY_NAME, { exact: true })).first()
  await entry.click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()
}

try {
  const url = await bootUrl()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Installed after the page exists and BEFORE the first navigation: `addInitScript` only
  // applies to navigations that happen after it is registered, and the helper used to be
  // installed on a `page` that was still `undefined` — a TypeError that killed the whole
  // probe before a browser was ever launched.
  await installRowKeyHelpers(page)
  page.on('console', (message) => { if (message.type() === 'error') logs.push(message.text()) })
  page.on('pageerror', (error) => { logs.push(`pageerror: ${error.message}`) })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
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
  check('it carries this plugin\'s copy', cardText.includes(CARD_COPY), cardText.slice(0, 80))
  check('and its trigger shows the stored destination',
    (await pillar().innerText().catch(() => '')).includes(DEST_UNGROUPED),
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
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
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
    items.length === 3 && items.join('|').includes(DEST_UNGROUPED)
      && items.join('|').includes(DEST_CURRENT) && items.join('|').includes(DEST_RECENT),
    JSON.stringify(items))

  // The native `<select>` the voice-input card uses renders its popup with the
  // operating system's colours, so it goes light on a dark theme. The Menu draws
  // its own themed surface instead — so the popup must not be the light fill a
  // native popup would be.
  const surface = await measureSurface(menu)
  console.log(`menu surface: ${JSON.stringify(surface)}`)
  check('the popup is themed rather than the OS light fill',
    surface.fill !== undefined && surface.fill !== 'rgb(255, 255, 255)',
    JSON.stringify(surface))

  // ── 3. Choosing "recent" is stored and shown. ──
  await menu.getByRole('menuitem', { name: DEST_RECENT }).click()
  await page.waitForTimeout(2500)
  const afterPick = await domain()
  console.log(`stored global: ${JSON.stringify(afterPick.global)}`)
  check('choosing an option stores it on the Host',
    afterPick.global?.newSessionTarget === TARGET_RECENT, JSON.stringify(afterPick.global))
  check('and the trigger shows the new choice',
    (await pillar().innerText().catch(() => '')).includes('最后活跃'), await pillar().innerText().catch(() => '(no pill)'))
  check('and the project order survived the write',
    Object.keys(afterPick.projects).length === 1, JSON.stringify(Object.keys(afterPick.projects)))

  // ── 4. The choice actually drives the shell's New Session button. ──
  await dismiss()
  const beforeTopClick = await blankOwner()
  await page.locator('button[aria-label="新建会话"]').first().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  const filed = await blankOwner()
  console.log(`after the top New Session with "recent": ${JSON.stringify(filed)}`)
  // Recorded explicitly: a blank Session is REUSED by identity, so "it is filed under alpha"
  // alone would also pass if the click had done nothing and the Session was already there.
  // Stating the before/after ids makes the identity-reuse premise visible in the output.
  console.log(`  blank Session id before=${String(beforeTopClick.id)} after=${String(filed.id)}`)
  check('the stored destination drives the New Session button',
    filed.owner === alpha, JSON.stringify(filed))

  // ── 5. Switching back to Ungrouped takes effect too. ──
  await openCard()
  await pillar().click()
  await page.waitForTimeout(900)
  await page.getByRole('menu').first().getByRole('menuitem', { name: DEST_UNGROUPED }).click()
  await page.waitForTimeout(2500)
  // Read the file ONCE: two `domain()` calls in one assertion can observe different
  // contents, so the PASS/FAIL decision and the logged value could disagree.
  const afterSwitchBack = await domain()
  check('switching back stores Ungrouped',
    afterSwitchBack.global?.newSessionTarget === TARGET_UNGROUPED, JSON.stringify(afterSwitchBack.global))
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
    const reading = await measureSurface(page.getByRole('menu').first())
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

  // The validate switch sits above the injection chain (user's decision, 2026-10-09): it is the one
  // setting that depends on nothing else, so sitting after a four-row chain read as the last link
  // in it. Numbered `6b)` rather than `7)` — it is not part of the popup section above it, and the
  // `7)` group went with the injection preview.
  const cardOrder = await card().evaluate((root, labels) => {
    const text = root.innerText
    return labels.map(label => text.indexOf(label))
  }, [SWITCH_VALIDATE, SWITCH_INJECT_INFO, '注入项目文档'])
  check('6b) 校验开关排在「注入项目信息」之前',
    cardOrder[0] !== -1 && cardOrder[1] !== -1 && cardOrder[0] < cardOrder[1],
    JSON.stringify(cardOrder))
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
