/**
 * The cost of waiting for the override: what lingers when it is empty?
 *
 * Pruning is skipped while the caller's override is empty, because an empty
 * override cannot be told apart from one that has not answered. That guard has a
 * price: with genuinely zero projects, a deleted project's expansion key is not
 * pruned. This measures whether that is a bounded, self-healing artefact or an
 * unbounded leak, by driving the real UI through create/expand/delete cycles.
 *
 * Usage: node probe-empty-override-cost.mjs <baseUrlWithToken>
 */
import { chromium } from 'playwright-core'

const url = process.argv[2]
const STORE_KEY = 'dsh.workspace.view.v5'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismissModals = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Continue', 'Later', 'Got it', '知道了']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        await button.click({ force: true }).catch(() => {})
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(800)
  }
}

const expansion = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).groupExpansion, STORE_KEY)

/** Create a project, expand it, then delete it through the row menu. */
async function createExpandDelete(name) {
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(name)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)

  // Expand it, so an expansion record exists under its id.
  await page.locator('[data-row-key^="workspace:"]', { hasText: name }).first().click()
  await page.waitForTimeout(1200)
  const expanded = await expansion()
  const projectKey = Object.keys(expanded).find(key => key !== '' && expanded[key] === true)

  // Delete it through the row menu.
  const row = page.locator('[data-row-key^="workspace:"]', { hasText: name }).first()
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await row.locator('button[aria-label^="项目"]').first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(800)
  const del = page.getByText('删除项目', { exact: true }).first()
  if (await del.count() > 0) {
    await del.click({ force: true }).catch(() => {})
    await page.waitForTimeout(800)
    const confirm = page.getByRole('button', { name: '删除项目' }).last()
    if (await confirm.count() > 0) { await confirm.click({ force: true }).catch(() => {}); await page.waitForTimeout(2000) }
  }
  return projectKey
}

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(6000)
await dismissModals()

console.log('=== three create/expand/delete cycles, ending with zero projects ===')
const keys = []
for (let round = 1; round <= 3; round += 1) {
  const name = `cost-${round}-${Date.now().toString(36)}`
  const key = await createExpandDelete(name)
  const now = await expansion()
  const projectKeys = Object.keys(now).filter(candidate => candidate !== '')
  keys.push(key)
  console.log(`round ${round}: created+deleted ${key}`)
  console.log(`  expansion now: ${JSON.stringify(now)}`)
  console.log(`  stale project keys lingering: ${projectKeys.length} ${JSON.stringify(projectKeys)}`)
}

const final = await expansion()
const lingering = Object.keys(final).filter(key => key !== '')
console.log(`\n=== result ===`)
console.log(`cycles run            : 3`)
console.log(`distinct keys created : ${new Set(keys.filter(Boolean)).size}`)
console.log(`keys lingering at end : ${lingering.length} ${JSON.stringify(lingering)}`)
console.log(lingering.length <= 1
  ? 'BOUNDED: at most the last deleted project lingers, and the next create prunes it.'
  : `UNBOUNDED: ${lingering.length} keys accumulated.`)

await browser.close()
process.exit(0)
