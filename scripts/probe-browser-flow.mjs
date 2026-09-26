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
// no credentials). Dismiss whichever is present through its own button.
for (const label of ['稍后配置', '继续', 'Continue', 'Later', 'Got it', '知道了']) {
  const button = page.getByRole('button', { name: label, exact: true }).first()
  if (await button.count() > 0) {
    await button.click().catch(() => {})
    await page.waitForTimeout(1000)
  }
}
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

// Clean up through the UI so the instance is left as it was found. The row menu
// is hover-revealed, so the row is hovered before its button is clickable.
// The reload above re-opens the API-key gate on an isolated profile, so the
// cleanup dismisses it again; if it still masks, cleanup is skipped rather than
// reported as a failure — it is housekeeping, not the behaviour under test.
for (const label of ['稍后配置', 'Later']) {
  const button = page.getByRole('button', { name: label, exact: true }).first()
  if (await button.count() > 0) { await button.click({ force: true }).catch(() => {}); await page.waitForTimeout(1000) }
}
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
