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
  return row?.getAttribute('data-row-key')?.replace('session:', '') ?? null
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
  const entry = page.locator('text=dsh-project-groups').first()
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
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
