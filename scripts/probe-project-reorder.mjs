/**
 * Does dragging a Session inside a project reorder it, and switch to manual?
 *
 * Project rows are not Workspaces: the region's drag commit looked a key up among
 * Workspace ids, found nothing for a project, and returned — so a project's rows
 * could be dragged and would show an insertion marker, but releasing did nothing.
 * Projects are now in the ordering pipeline with their own stored order.
 *
 * This drives the real UI: two Sessions in a project, dragged to swap, with the
 * view menu's ordering mode read before and after.
 *
 * Usage: node probe-project-reorder.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-reorder.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = 17642
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

function boot(profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => reject(new Error(`timed out booting ${profile}: ${out.slice(-400)}`)), 120_000)
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) {
        clearTimeout(timer)
        setTimeout(() => resolve({ child, url: match[1] }), 3000)
      }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${profile} exited with ${code}`)) })
  })
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors = []
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })

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

/**
 * Session row locators under one group heading, in rendered order.
 *
 * Scoped to the group: a bare `[data-row-key^="session:"]` matches rows in every
 * group, so an earlier version of this probe dragged a row that belonged
 * somewhere else and read the result as "reordering does nothing".
 */
const sessionRowsUnder = (headingText) => page.evaluate((text) => {
  const section = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .find(node => (node.textContent ?? '').includes(text))
  if (section === undefined) return []
  const scope = section.closest('div[role="treeitem"]')?.parentElement ?? section.parentElement
  return [...scope.querySelectorAll('[data-row-key^="session:"]')]
    .map(node => node.getAttribute('data-row-key'))
}, headingText)

/**
 * The ordering mode, read from the view store that persists it.
 *
 * Reading the menu's DOM would mean guessing which row carries the selection
 * marker; the store is the authoritative record and the menu is a view of it.
 */
const orderMode = () => page.evaluate(() => {
  const raw = localStorage.getItem('dsh.workspace.view.v5')
  return raw === null ? null : JSON.parse(raw).orderBy ?? null
})

let server
try {
  server = await boot('pg')
  await page.goto(server.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6000)
  await dismissModals()

  // Two Sessions in one project, so there is something to reorder.
  const unique = `reorder-${Date.now().toString(36)}`
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(unique)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)

  const projectRow = page.locator('[data-row-key^="workspace:"]', { hasText: unique }).first()
  // The project's own ＋ files each new Session under it. Two Sessions are needed,
  // because a project's first ＋ reuses the blank one: the first gets a message so
  // it stops being the reusable blank, then the second is created fresh.
  const createProjectSession = async (message) => {
    await dismissModals()
    await projectRow.hover({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(400)
    await projectRow.locator('button[aria-label^="在"]').first().dispatchEvent('click')
    await page.waitForTimeout(3000)
    if (message === undefined) return
    await dismissModals()
    const composer = page.locator('[data-composer-input="true"]').first()
    if (await composer.count() === 0) return
    await composer.click({ force: true }).catch(() => {})
    await composer.fill(message).catch(() => {})
    await page.keyboard.press('Enter')
    await page.waitForTimeout(7000)
  }
  await createProjectSession('first session')
  await createProjectSession('second session')

  const beforeKeys = await sessionRowsUnder(unique)
  const before = beforeKeys.map(key => key.replace('session:', ''))
  console.log(`sessions in the project, in order: ${JSON.stringify(before)}`)
  check('the project holds two Sessions', before.length === 2, JSON.stringify(before))
  if (before.length !== 2) throw new Error('cannot reorder without two rows')

  const modeBefore = await orderMode()
  console.log(`ordering mode before: ${JSON.stringify(modeBefore)}`)

  // Drag the second row onto the TOP of the first. The drop side is chosen by
  // comparing the pointer against the row's midpoint (`rowHalf`), so dropping on
  // a row's centre means "after it" — which for row 2 onto row 1 is where the row
  // already is, and the reorder is a no-op that looks like a broken feature.
  const projectSection = page.locator('[data-row-key^="workspace:"]', { hasText: unique }).first()
  const scoped = projectSection.locator('xpath=ancestor::div[contains(@class,"groupSection")]')
    .locator('[data-row-key^="session:"]')
  const source = scoped.nth(1)
  const target = scoped.nth(0)
  check('both rows are addressable for the drag',
    await source.count() > 0 && await target.count() > 0,
    `source=${await source.count()} target=${await target.count()}`)
  const targetBox = await target.boundingBox()
  if (targetBox === null) throw new Error('the target row is not laid out')
  await source.dragTo(target, {
    targetPosition: { x: targetBox.width / 2, y: 1 },
    timeout: 20_000,
  })
  await page.waitForTimeout(3000)

  const after = (await sessionRowsUnder(unique)).map(key => key.replace('session:', ''))
  console.log(`sessions in the project, after the drag: ${JSON.stringify(after)}`)
  check('the drag reordered the project\'s Sessions',
    after.length === 2 && after[0] === before[1] && after[1] === before[0],
    JSON.stringify({ before, after }))

  // The drag is a sort gesture, so it selects manual ordering — upstream's rule.
  const modeAfter = await orderMode()
  console.log(`ordering mode after: ${JSON.stringify(modeAfter)}`)
  check('the drag switched ordering to manual', modeAfter === 'manual',
    JSON.stringify({ modeBefore, modeAfter }))

  // Reload: the order is on the Host, so it must come back.
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismissModals()
  const reloaded = (await sessionRowsUnder(unique)).map(key => key.replace('session:', ''))
  console.log(`sessions after reload: ${JSON.stringify(reloaded)}`)
  check('the new order survives a reload (it is on the Host)',
    reloaded.length === 2 && reloaded[0] === before[1] && reloaded[1] === before[0],
    JSON.stringify(reloaded))

  console.log(`\nconsole errors: ${errors.length === 0 ? '(none)' : errors.join(' | ')}`)
} finally {
  if (server?.child !== undefined && server.child.exitCode === null) {
    server.child.kill()
    await new Promise(resolve => setTimeout(resolve, 4000))
  }
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
