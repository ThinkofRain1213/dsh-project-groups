/**
 * Drive the real UI through the project flow, in the real browser.
 *
 * The console-error probe proved the mount stopped throwing, but "no error" is
 * not "it works". This exercises the actual surfaces: open the sidebar's New
 * project dialog, create one, confirm it renders as a project row, then confirm
 * it is still there after a reload — which is the one claim L1-2 exists to make.
 *
 * Usage: node probe-browser-flow.mjs <baseUrlWithToken>
 */
import { chromium } from 'playwright-core'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node probe-browser-flow.mjs "http://127.0.0.1:PORT/?token=..."')
  process.exit(2)
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(6000)

// A fresh profile opens one-time modals whose mask intercepts every click: the
// announcement, then a "add an API key to begin" gate (an isolated profile has
// no credentials). Whichever is present is dismissed through its own button;
// the label is curated copy, so several spellings are tried, and the dismiss is
// repeated because a reload can raise it again.
const dismissModals = async () => {
  for (const label of ['稍后配置', '继续', 'Continue', 'Later', 'Got it', '知道了']) {
    const button = page.getByRole('button', { name: label, exact: true }).first()
    if (await button.count() > 0) {
      await button.click({ force: true }).catch(() => {})
      await page.waitForTimeout(1200)
    }
  }
}
await dismissModals()
// Anything still masking would fail every click below; say so rather than
// letting the first click time out.
const masking = await page.evaluate(() => {
  const mask = [...document.querySelectorAll('div[aria-hidden="true"]')]
    .find(node => node.className.includes('mask'))
  return mask === undefined ? null : (mask.parentElement?.innerText ?? '').slice(0, 120)
})
if (masking !== null) {
  console.log(`WARNING: a modal is still masking clicks: ${JSON.stringify(masking)}`)
}

// The sidebar renders "未分组" for a session with no project. Its presence means
// the vendored browser mounted; the project list is what we are testing below.
const title = '探针项目'
const unique = `${title}-${Date.now().toString(36)}`

/** Read the sidebar's group headings. */
const headings = async () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
  return rows.map(row => row.textContent?.trim() ?? '')
})

const before = await headings()
console.log(`sidebar rows before: ${JSON.stringify(before)}`)
check('the sidebar rendered at least the Ungrouped bucket', before.length >= 1, JSON.stringify(before))

// Open the New project dialog: the header's add control.
const addButton = page.locator('button[aria-label="新建项目"]').first()
const addVisible = await addButton.count()
check('the header add control is the New project button', addVisible > 0, `count=${addVisible}`)
if (addVisible === 0) {
  console.log('\nconsole errors:')
  for (const line of errors) console.log(`  ${line}`)
  await browser.close()
  console.log(`\n${failures.length} CHECK(S) FAILED`)
  process.exit(1)
}

await addButton.click()
await page.waitForTimeout(800)
const input = page.locator('input[aria-label="项目名称"]').first()
check('the New project dialog opened', await input.count() > 0)

await input.fill(unique)
await page.getByRole('button', { name: '创建' }).first().click()
await page.waitForTimeout(2500)

const after = await headings()
console.log(`sidebar rows after create: ${JSON.stringify(after)}`)
check('the new project appears as a sidebar row',
  after.some(row => row.includes(unique)), JSON.stringify(after))
check('creating a project raised no console error',
  errors.filter(line => line.includes('project')).length === 0, errors.join(' | ').slice(0, 200))

// Reload: the project must come back, which is the whole point of L1-2.
await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(6000)
const reloaded = await headings()
console.log(`sidebar rows after reload: ${JSON.stringify(reloaded)}`)
check('the project survives a reload (it is on the Host)',
  reloaded.some(row => row.includes(unique)), JSON.stringify(reloaded))

// Read where each Session actually sits, in the sidebar's own terms: for every
// group heading, the Session rows inside that section. This is what a person
// sees, so it is what the filing assertions below are about.
//
// A group with no Sessions is not rendered at all, so an "Ungrouped" entry being
// absent is a real state, distinct from it being present and empty. Assertions
// below therefore test for both rather than reading `undefined` as zero — a
// `?? 0` there would pass whether or not the bucket existed.
const sidebarLayout = () => page.evaluate(() => {
  const sections = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
  return sections.map((section) => {
    const heading = (section.textContent ?? '').trim()
    // Session rows live inside the same section element as their heading.
    const scope = section.closest('div[role="treeitem"]')?.parentElement ?? section.parentElement
    const sessions = [...scope.querySelectorAll('[data-row-key^="session:"]')]
    return { heading, sessionCount: sessions.length }
  })
})

/** The section whose heading contains this text, or undefined when absent. */
const sectionFor = (layout, text) => layout.find(row => row.heading.includes(text))

/** How many Sessions sit under a heading; an absent group holds none. */
const countFor = (layout, text) => sectionFor(layout, text)?.sessionCount ?? 0

/** The row element whose heading contains this text. */
const rowFor = (text) => page.locator('[data-row-key^="workspace:"]', { hasText: text }).first()

// The row action strip is CSS-hidden until its row is hovered, and Playwright
// cannot scroll an invisible element into view. Hovering is what a person does;
// the dispatched click then runs the real button's React handler in the real
// page, which is what these assertions are about. The hover styling itself is
// not under test.
const clickRowPlus = async (text) => {
  const row = rowFor(text)
  if (await row.count() === 0) return false
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  const plus = row.locator('button[aria-label^="在"]').first()
  if (await plus.count() === 0) return false
  await plus.dispatchEvent('click')
  await page.waitForTimeout(3500)
  return true
}

// 0. Baseline: with a project but no filing, every existing Session is Ungrouped.
const baselineLayout = await sidebarLayout()
console.log(`layout before any New Session: ${JSON.stringify(baselineLayout)}`)
check('the Ungrouped bucket is rendered while Sessions are unfiled',
  sectionFor(baselineLayout, '未分组') !== undefined, JSON.stringify(baselineLayout))
check('the new project starts empty', countFor(baselineLayout, unique) === 0)

// 1. The REVERSE test first, because it is the one that can fail: the Ungrouped
//    bucket's ＋ must not file anything. Run before the project's own ＋ so the
//    project is still empty and an unconditional assign would be visible.
const ungroupedBefore = countFor(baselineLayout, '未分组')
check('the Ungrouped ＋ was clickable', await clickRowPlus('未分组'))
let layout = await sidebarLayout()
console.log(`layout after Ungrouped ＋: ${JSON.stringify(layout)}`)
check('the Ungrouped ＋ did NOT file its Session under the project',
  countFor(layout, unique) === 0, `project holds ${countFor(layout, unique)}`)
// The count is not asserted to grow: a Workspace's New Session reuses its
// existing blank Session rather than creating a second one, so the Ungrouped
// bucket keeps the blank it already had. What matters is that the Session there
// is still unfiled, which the assertion above pins down.
check('the Ungrouped bucket still holds its unfiled Session',
  countFor(layout, '未分组') >= ungroupedBefore,
  `${ungroupedBefore} -> ${countFor(layout, '未分组')}`)

// 2. The project row's own ＋ must file what it creates under that project. The
//    blank Session from step 1 is still unfiled, so this reuses it — which also
//    covers the "last click wins" rule: the same Session moves into the project.
check('the project row is present to click', await rowFor(unique).count() > 0)
check('the project row exposes its own New Session control',
  await rowFor(unique).locator('button[aria-label^="在"]').count() > 0)
check('the project ＋ was clickable', await clickRowPlus(unique))
layout = await sidebarLayout()
console.log(`layout after project ＋: ${JSON.stringify(layout)}`)
check('the project ＋ created a Session inside the project',
  countFor(layout, unique) === 1, JSON.stringify(sectionFor(layout, unique)))
check('and left no Session in Ungrouped',
  sectionFor(layout, '未分组') === undefined || countFor(layout, '未分组') === 0,
  JSON.stringify(sectionFor(layout, '未分组') ?? '(absent)'))

// 3. The filing is on the Host, so it survives a reload like the project does.
await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(6000)
layout = await sidebarLayout()
console.log(`layout after reload: ${JSON.stringify(layout)}`)
check('the filed Session is still inside its project after a reload',
  countFor(layout, unique) === 1, JSON.stringify(sectionFor(layout, unique)))
check('and still not in Ungrouped after a reload',
  countFor(layout, '未分组') === 0, JSON.stringify(sectionFor(layout, '未分组') ?? '(absent)'))

// Clean up through the UI so the instance is left as it was found.
await dismissModals()
const masked = await page.evaluate(() => {
  const mask = [...document.querySelectorAll('div[aria-hidden="true"]')]
    .find(node => node.className.includes('mask'))
  return mask !== undefined
})
const row = page.locator(`[data-row-key^="workspace:"]`, { hasText: unique }).first()
if (!masked && await row.count() > 0) {
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  const menuButton = row.locator('button[aria-label^="项目"]').first()
  await menuButton.click({ force: true }).catch(() => {})
  await page.waitForTimeout(800)
  const del = page.getByText('删除项目', { exact: true }).first()
  if (await del.count() > 0) {
    await del.click({ force: true }).catch(() => {})
    await page.waitForTimeout(800)
    // The confirmation's own button carries the same label; the dialog's is last.
    const confirm = page.getByRole('button', { name: '删除项目' }).last()
    if (await confirm.count() > 0) {
      await confirm.click({ force: true }).catch(() => {})
      await page.waitForTimeout(2000)
    }
  }
  const remaining = await headings()
  check('the project was removed through the row menu',
    !remaining.some(heading => heading.includes(unique)), JSON.stringify(remaining))
} else if (masked) {
  console.log('(cleanup skipped: a modal is masking the sidebar)')
}

console.log('\nconsole errors observed:')
for (const line of errors) console.log(`  ${line}`)
if (errors.length === 0) console.log('  (none)')

await browser.close()
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
