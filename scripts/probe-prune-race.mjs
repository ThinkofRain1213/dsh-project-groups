/**
 * Catch the exact write that drops a project's expansion.
 *
 * `probe-expansion-persistence` and `probe-retain-order` disagreed on the same
 * build, so the prune is a race, not a rule. This isolates it: seed the store
 * with a project key already present, reload, and record every write to the view
 * key. The write that omits the project key is the one that loses it, and the
 * writes around it say what the browser knew at that moment.
 *
 * Usage: node probe-prune-race.mjs <baseUrlWithToken>
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

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(6000)
await dismissModals()

// Make a project and expand it, so a real project key exists on disk.
const unique = `race-${Date.now().toString(36)}`
await page.locator('button[aria-label="新建项目"]').first().click()
await page.waitForTimeout(800)
await page.locator('input[aria-label="项目名称"]').first().fill(unique)
await page.getByRole('button', { name: '创建' }).first().click()
await page.waitForTimeout(2500)
await page.locator('[data-row-key^="workspace:"]', { hasText: unique }).first().click()
await page.waitForTimeout(1500)

const seeded = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).groupExpansion, STORE_KEY)
const projectKey = Object.keys(seeded).find(key => key !== '')
console.log(`seeded expansion : ${JSON.stringify(seeded)}`)
console.log(`project key      : ${projectKey}`)
if (projectKey === undefined) {
  console.log('no project key was recorded; cannot isolate the race')
  await browser.close()
  process.exit(1)
}

// The fix must not stop retention from pruning a key that is genuinely gone.
// A project that no longer exists must still be dropped, or the store would grow
// forever. Seed a key belonging to no project and confirm it does not survive.
await page.evaluate(({ key }) => {
  const current = JSON.parse(localStorage.getItem(key))
  current.groupExpansion = { ...current.groupExpansion, 'project-that-was-deleted': true }
  localStorage.setItem(key, JSON.stringify(current))
}, { key: STORE_KEY })
await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(8000)
const stale = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).groupExpansion, STORE_KEY)
console.log(`\nstale-key prune: a project that no longer exists is ${stale['project-that-was-deleted'] === undefined ? 'PRUNED (correct)' : 'still present (leak)'}`)

// Reload several times, recording writes each time. A race shows up as some
// reloads losing the key and others keeping it.
let lost = 0
let kept = 0
for (let attempt = 1; attempt <= 3; attempt += 1) {
  // Re-seed so every attempt starts from the same state.
  await page.evaluate(({ key, value }) => {
    const current = JSON.parse(localStorage.getItem(key))
    current.groupExpansion = { ...current.groupExpansion, [value]: true }
    localStorage.setItem(key, JSON.stringify(current))
  }, { key: STORE_KEY, value: projectKey })

  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem
    window.__writes = []
    Storage.prototype.setItem = function (name, value) {
      if (name === key) {
        const parsed = JSON.parse(value)
        window.__writes.push({ at: Math.round(performance.now()), expansion: parsed.groupExpansion })
      }
      return original.call(this, name, value)
    }
  }, STORE_KEY)

  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)

  const writes = await page.evaluate(() => window.__writes)
  const after = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).groupExpansion, STORE_KEY)
  const survived = after[projectKey] === true
  if (survived) kept += 1
  else lost += 1

  console.log(`\n--- reload ${attempt}: ${survived ? 'KEPT' : 'LOST'} ---`)
  for (const write of writes) {
    const dropped = write.expansion[projectKey] === undefined
    console.log(`  at ${String(write.at).padStart(5)}ms ${dropped ? 'DROPS project key' : 'has  project key'}  ${JSON.stringify(write.expansion)}`)
  }
}

console.log(`\nRESULT: kept ${kept}, lost ${lost} out of 3 reloads`)
console.log(kept > 0 && lost > 0
  ? 'CONFIRMED: the prune is a race — the same build both keeps and drops it.'
  : kept === 0
    ? 'the key is always dropped'
    : 'the key was never dropped in these runs')

await browser.close()
process.exit(0)
