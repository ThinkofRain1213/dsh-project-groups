/**
 * Does the Ungrouped row's ＋ create a Session under Ungrouped?
 *
 * It did not. The row sent no `beforeOpen` callback, which made the click
 * indistinguishable from an unscoped one (the shell's New Session button): it
 * resolved the default Workspace, reused the blank Session already sitting there,
 * and inherited whatever project that Session had been filed under. So after any
 * project's ＋ had been used once, the Ungrouped ＋ kept creating under that
 * project instead.
 *
 * The probe drives the reported path and reads the Host's own assignment table,
 * so it measures ownership rather than which group a row happened to render in.
 *
 * Usage: node probe-ungrouped-plus.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { installRowKeyHelpers } from './lib/row-key.mjs'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-ungrouped-plus.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = 17680
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

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

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await installRowKeyHelpers(page)
const logs = []
page.on('console', (message) => { if (message.type() === 'error') logs.push(message.text()) })

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

/** The Host's assignment table, read from this plugin's own domain file. */
const assignments = async () => {
  try {
    const text = await readFile(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
    return JSON.parse(text).tables.assignments ?? {}
  } catch {
    return {}
  }
}

/** Session ids under one group heading, in rendered order. */
const sessionsUnder = (headingText) => page.evaluate((text) => {
  const section = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .find(node => (node.textContent ?? '').includes(text))
  if (section === undefined) return []
  const scope = section.closest('div[class*="groupSection"]') ?? section.parentElement
  return [...scope.querySelectorAll('[data-row-key^="session:"]')]
    .map(node => window.__sessionIdOf(node.getAttribute('data-row-key')) ?? '')
}, headingText)

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()
const ungroupedRow = () => page.locator('[data-row-key="workspace:"]').first()

const makeProject = async (title) => {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

/** Click a group row's ＋ and wait for the new Session to appear. */
const clickPlus = async (row) => {
  await dismiss()
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await row.locator('button[aria-label^="在"]').first().dispatchEvent('click')
  await page.waitForTimeout(4500)
}

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  const stamp = Date.now().toString(36)
  const alpha = `甲${stamp}`
  await makeProject(alpha)
  await dismiss()

  const ungroupedBefore = await sessionsUnder('未分组')
  console.log(`未分组 before: ${JSON.stringify(ungroupedBefore)}`)

  // Step 1: 甲's ＋. This is the trigger — it files the shared blank Session
  // under 甲, which is what the Ungrouped ＋ then inherited.
  //
  // One Session moves between the two rows rather than a new one appearing:
  // `reuseOrCreateBlank` reuses the Workspace's single blank Session, and every
  // project shares one Workspace (a project has no directory). So the assertions
  // below track *that* Session's owner, not a count.
  await clickPlus(projectRow(alpha))
  const alphaAfterPlus = await sessionsUnder(alpha)
  const ownersAfterPlus = await assignments()
  const ungroupedAfterPlus = await sessionsUnder('未分组')
  const moved = alphaAfterPlus[0]
  console.log(`甲 after its ＋: ${JSON.stringify(alphaAfterPlus)}`)
  console.log(`未分组 after 甲's ＋: ${JSON.stringify(ungroupedAfterPlus)}`)
  check('the project ＋ put a Session under the project',
    alphaAfterPlus.length === 1, JSON.stringify(alphaAfterPlus))
  check('and the Host filed that Session under the project',
    moved !== undefined && ownersAfterPlus[moved]?.projectId !== undefined,
    JSON.stringify(ownersAfterPlus))

  // Step 2: the Ungrouped row's ＋ — the reported failure.
  await clickPlus(ungroupedRow())
  const ungroupedAfter = await sessionsUnder('未分组')
  const alphaFinal = await sessionsUnder(alpha)
  const owners = await assignments()

  console.log(`未分组 after its ＋: ${JSON.stringify(ungroupedAfter)}`)
  console.log(`甲 after the Ungrouped ＋: ${JSON.stringify(alphaFinal)}`)
  console.log(`assignments: ${JSON.stringify(owners)}`)

  // The decisive assertion: the Session now sits under Ungrouped with NO
  // assignment entry. Counting rows would pass on the broken build too — the
  // Session renders somewhere either way; what differs is who owns it.
  check('the Ungrouped ＋ moved the Session under Ungrouped',
    moved !== undefined && ungroupedAfter.includes(moved),
    JSON.stringify({ moved, ungroupedAfter, alphaFinal }))
  check('and the Host holds no assignment for it',
    moved !== undefined && owners[moved] === undefined,
    JSON.stringify({ moved, owner: moved === undefined ? null : owners[moved] ?? null }))
  check('the project no longer holds it',
    alphaFinal.length === 0, JSON.stringify(alphaFinal))

  console.log(`\nconsole errors: ${logs.length === 0 ? '(none)' : logs.slice(0, 5).join(' | ')}`)
} finally {
  child.kill()
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
