/**
 * Does `recent` stop letting the blank New Session choose its own destination?
 *
 * The defect: `reuseOrCreateBlank` reuses the Workspace's single blank Session, so
 * the Session being placed is already in the Session list — with its own creation
 * time — and it carries whatever project it was last filed under. Counting that
 * row as activity handed that project a fresh timestamp it did no work for, so
 * `recent` kept landing in the same project.
 *
 * ## The discriminating scenario
 *
 * Two projects, both with no Sessions of their own, and a blank Session parked in
 * 甲 by clicking 甲's ＋. Their `createdAt`s are then rewritten so that 乙 is the
 * newer project, which is the only fact that should decide the answer:
 *
 *   project 甲  createdAt = 2019   (holds a blank Session whose time is "now")
 *   project 乙  createdAt = 2021   (empty)
 *
 *   before the fix: 甲 wins on the blank row's fresh timestamp
 *   after the fix:  the blank is excluded, so 乙 wins on its newer createdAt
 *
 * The rewrite happens on the domain file with the Host stopped, then the Host is
 * restarted: it keeps the parsed global in memory once the domain is open, so a
 * file change is invisible to a running process (measured in step 2).
 *
 * Usage: node probe-recent-blank.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { installRowKeyHelpers } from './lib/row-key.mjs'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-recent-blank.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = 17689
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Boot the profile and resolve once the shell prints its token URL. */
function boot() {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [BIN, '--profile', 'pg', '--port', String(PORT), '--no-open'], {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const timer = setTimeout(() => reject(new Error(`boot timeout: ${out.slice(-300)}`)), 120_000)
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) { clearTimeout(timer); setTimeout(() => resolve({ child, url: match[1] }), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited early with ${code}: ${out.slice(-300)}`)) })
  })
}

const stop = async (child) => {
  child.kill()
  await new Promise(resolve => setTimeout(resolve, 4000))
}

const domainPath = () => join(dshHome, 'storages', 'project_groups.json')
const domain = async () => JSON.parse(await readFile(domainPath(), 'utf8'))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await installRowKeyHelpers(page)
const logs = []
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

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()

const makeProject = async (title) => {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

/** Click a project row's ＋, which files the blank Session under it. */
const clickPlus = async (row) => {
  await dismiss()
  const plus = row.locator('button[aria-label^="在"]').first()
  // Resolve the button before dispatching, and report what was clicked: a
  // dispatch against a row that has not rendered its ＋ yet is a silent no-op,
  // which then reads as the placement having failed.
  const label = await plus.getAttribute('aria-label', { timeout: 10_000 }).catch(() => null)
  console.log(`clicking ＋: ${JSON.stringify(label)}`)
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await plus.dispatchEvent('click')
  await page.waitForTimeout(4500)
}

/**
 * Wait for the blank Session to carry an assignment, then report its owner.
 *
 * Polled rather than read once: the placement is a Remote round trip and the
 * sidebar re-renders around it, so a fixed sleep races it and reports "no owner"
 * against a working build.
 */
const settledOwner = async (timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs
  let last = { id: null, owner: undefined }
  while (Date.now() < deadline) {
    last = await blankOwner()
    if (last.owner !== undefined) return last
    await page.waitForTimeout(600)
  }
  return last
}

/**
 * Wait until the blank Session's owner stops being `from`, then report it.
 *
 * A plain "wait for an owner" is not enough after the seed: the blank is already
 * filed under the first project and stays that way until the placement lands, so
 * the first read would return the old value and the assertion would measure the
 * seed rather than the click.
 */
const ownerAfter = async (from, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  let last = await blankOwner()
  while (Date.now() < deadline) {
    if (last.owner !== from) return last
    await page.waitForTimeout(600)
    last = await blankOwner()
  }
  return last
}

/** Store the destination over the plugin's own RPC, the endpoint the card uses. */
const setTarget = async (target) => {
  await page.evaluate(async ({ base, token, value }) => {
    await fetch(`${base}/api/projectGroups/setNewSessionTarget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `probe-${Math.random().toString(36).slice(2)}`,
        method: 'projectGroups/setNewSessionTarget',
        payload: { args: { request: { target: value } } },
      }),
    })
  }, { base: new URL(page.url()).origin, token: new URL(page.url()).searchParams.get('token') ?? '', value: target })
  await page.waitForTimeout(2500)
}

/** The Session the sidebar renders as the unstarted one. */
const blankSessionId = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-row-key^="session:"]')]
    .find(node => (node.textContent ?? '').includes('新会话'))
  return window.__sessionIdOf(row?.getAttribute('data-row-key'))
})

const blankOwner = async () => {
  const id = await blankSessionId()
  if (id === null) return { id: null, owner: undefined }
  // Read through `tables`: the domain file's shape is `{ unit, global, tables }`,
  // so a top-level destructure silently yields empty maps and reports "no owner"
  // against a working build.
  const parsed = await domain()
  const assignments = parsed.tables.assignments ?? {}
  const projects = parsed.tables.projects ?? {}
  const record = assignments[id]
  return { id, owner: record === undefined ? undefined : projects[record.projectId]?.title }
}

let running
try {
  // ── Phase 1: two empty projects, and a blank parked in the first. ──
  running = await boot()
  await page.goto(running.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  const stamp = Date.now().toString(36)
  const older = `甲${stamp}`
  const newer = `乙${stamp}`
  await makeProject(older)
  await makeProject(newer)
  await clickPlus(projectRow(older))

  const seeded = await settledOwner()
  console.log(`after ${older}'s ＋: ${JSON.stringify(seeded)}`)
  if (seeded.owner !== older) {
    // Report what the domain actually holds, so a setup failure is not confused
    // with a placement failure.
    const state = await domain()
    console.log(`  assignments: ${JSON.stringify(state.tables.assignments ?? {})}`)
    console.log(`  projects: ${JSON.stringify(Object.entries(state.tables.projects)
      .map(([id, p]) => [p.title, id, p.createdAt]))}`)
  }
  check('the blank Session is filed under the first project',
    seeded.owner === older, JSON.stringify(seeded))

  const beforeEdit = await domain()
  const idOf = (title) => beforeEdit.global.projectIds
    .find(candidate => beforeEdit.tables.projects[candidate].title === title)
  console.log(`projects: ${JSON.stringify(beforeEdit.global.projectIds)}`)
  check('both projects exist', idOf(older) !== undefined && idOf(newer) !== undefined,
    JSON.stringify(Object.values(beforeEdit.tables.projects).map(p => p.title)))

  // ── Phase 2: rewrite both createdAt values so only the newer project should win. ──
  await stop(running.child)
  const edited = await domain()
  edited.tables.projects[idOf(older)].createdAt = '2019-01-01T00:00:00.000Z'
  edited.tables.projects[idOf(newer)].createdAt = '2021-01-01T00:00:00.000Z'
  await writeFile(domainPath(), JSON.stringify(edited), 'utf8')
  console.log(`rewrote createdAt — ${older}=2019, ${newer}=2021`)

  // ── Phase 3: restart, choose `recent`, and click the shell's New Session. ──
  running = await boot()
  await page.goto(running.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  const reloaded = await domain()
  check('the rewrite survived the restart',
    reloaded.tables.projects[idOf(older)].createdAt.startsWith('2019')
      && reloaded.tables.projects[idOf(newer)].createdAt.startsWith('2021'),
    JSON.stringify({ older: reloaded.tables.projects[idOf(older)].createdAt, newer: reloaded.tables.projects[idOf(newer)].createdAt }))

  await setTarget('recent')
  const stored = await domain()
  check('the destination is set to recent',
    stored.global.newSessionTarget === 'recent', JSON.stringify(stored.global))

  await dismiss()
  await page.locator('button[aria-label="新建会话"]').first().click({ force: true })
  // The blank is filed under `older` from the seed, so wait for the owner to
  // change rather than for any owner at all.
  const landed = await ownerAfter(older)
  console.log(`after the New Session: ${JSON.stringify(landed)}`)
  check('the blank Session no longer decides its own destination',
    landed.owner === newer, JSON.stringify(landed))

  console.log(`\nconsole errors: ${logs.length === 0 ? '(none)' : logs.slice(0, 5).join(' | ')}`)
} finally {
  if (running !== undefined) running.child.kill()
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
