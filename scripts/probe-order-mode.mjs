/**
 * Does the ordering mode freeze and discard caller-owned project order?
 *
 * Recency mode stores nothing: a project with no record has its member positions
 * derived from `updatedAt`, which is what recency means. So the mode only means
 * anything if switching to manual freezes what is on screen, and switching back
 * discards it — the same lifecycle the view store's own accounts get.
 *
 * Without the freeze, the menu would read "manual" while an untouched project
 * kept re-sorting itself by recency. This measures the store on both sides of the
 * switch, and the Host's own record.
 *
 * Usage: node probe-order-mode.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-order-mode.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = 17646
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
      if (match !== null) { clearTimeout(timer); setTimeout(() => resolve({ child, url: match[1] }), 3000) }
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

/** The persisted ordering mode. */
const orderMode = () => page.evaluate(() => {
  const raw = localStorage.getItem('dsh.workspace.view.v5')
  return raw === null ? null : JSON.parse(raw).orderBy ?? null
})

/** Pick a mode from the view menu by its visible label. */
const pickOrderMode = async (label) => {
  await dismissModals()
  const trigger = page.locator('button[aria-label="视图选项"]').first()
  await trigger.click({ force: true })
  await page.waitForTimeout(800)
  await page.getByRole('menuitem', { name: label }).first().click({ force: true })
  await page.waitForTimeout(2000)
}

/** The Host's stored order records, read from the domain file. */
const storedOrders = async () => {
  try {
    const text = await readFile(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
    return JSON.parse(text).tables.orders ?? {}
  } catch {
    return {}
  }
}

let server
try {
  server = await boot('pg')
  await page.goto(server.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6000)
  await dismissModals()

  const unique = `mode-${Date.now().toString(36)}`
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(unique)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)

  const projectRow = page.locator('[data-row-key^="workspace:"]', { hasText: unique }).first()
  await projectRow.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await projectRow.locator('button[aria-label^="在"]').first().dispatchEvent('click')
  await page.waitForTimeout(3000)

  const mode0 = await orderMode()
  const orders0 = await storedOrders()
  console.log(`mode on arrival: ${JSON.stringify(mode0)}; stored orders: ${JSON.stringify(Object.keys(orders0))}`)
  check('a fresh install starts in recency mode', mode0 === 'updated', String(mode0))
  check('and stores no order records', Object.keys(orders0).length === 0, JSON.stringify(orders0))

  // Switching to manual must freeze every project, not just a dragged one.
  await pickOrderMode('手动排序')
  const mode1 = await orderMode()
  const orders1 = await storedOrders()
  console.log(`mode after picking manual: ${JSON.stringify(mode1)}; stored orders: ${JSON.stringify(orders1)}`)
  check('picking manual switches the mode', mode1 === 'manual', String(mode1))
  check('and freezes the project into a stored order',
    Object.keys(orders1).length === 1 && (orders1[Object.keys(orders1)[0]]?.sessionIds?.length ?? -1) === 1,
    JSON.stringify(orders1))

  // Switching back to recency discards it, which is the official lifecycle.
  await pickOrderMode('最近更新')
  const mode2 = await orderMode()
  const orders2 = await storedOrders()
  console.log(`mode after picking recency: ${JSON.stringify(mode2)}; stored orders: ${JSON.stringify(orders2)}`)
  check('picking recency switches the mode back', mode2 === 'updated', String(mode2))
  check('and discards the stored order', Object.keys(orders2).length === 0, JSON.stringify(orders2))

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
