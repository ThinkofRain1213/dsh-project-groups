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
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { redactToken } from './lib/redact.mjs'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-ungrouped-plus.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

// Overridable: a Host leaked by an earlier failed run keeps this port bound, and the only
// symptom would be an opaque "boot timeout" instead of a clear collision.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17680)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

let child
let browser
let page

const logs = []

/**
 * Boot the Host and resolve the tokenised dev-server URL.
 *
 * A function rather than top-level code so the whole boot path runs inside the try/finally
 * below: a boot timeout used to reject before the guarded region was entered, so the spawned
 * Host was never killed and kept this port bound for every later run.
 */
const boot = async () => {
  child = spawn(exe, [BIN, '--profile', 'pg', '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`boot timeout: ${redactToken(out.slice(-300))}`)), 120_000)
    // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
    // stdout, so without this handler the promise stayed pending until the 120 s timeout and
    // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
    // the process outright.
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`spawn failed for ${exe}: ${error.message}`))
    })
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) { clearTimeout(timer); setTimeout(() => resolve(match[1]), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
  })
}

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = () => dismissShared(page)

/** The rendered row keys, in order — the observable the waits below synchronise on. */
const rowKeys = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key]')]
  .map(node => node.getAttribute('data-row-key')))

/**
 * Wait until the rendered rows stop changing, instead of sleeping a flat 4.5 s.
 *
 * A fixed sleep either fails on a slow machine or passes for the wrong reason on a fast one.
 * `minMs` keeps the fast path from reading before the action can have reached the Host at all,
 * and `timeoutMs` bounds the slow path loudly instead of reading a half-rendered tree.
 */
const waitForRowsToSettle = async (label, { minMs = 2500, timeoutMs = 15_000 } = {}) => {
  const started = Date.now()
  let previous = null
  let stable = 0
  while (Date.now() - started < timeoutMs) {
    const current = JSON.stringify(await rowKeys())
    // A change resets the counter, so a row that appears late still extends the wait.
    stable = current === previous ? stable + 1 : 0
    if (stable >= 3 && Date.now() - started >= minMs) return true
    previous = current
    await page.waitForTimeout(250)
  }
  console.log(`  (${label}: 行列表在 ${String(timeoutMs)}ms 内没有稳定下来)`)
  return false
}

/**
 * The Host's assignment table, read from this plugin's own domain file.
 *
 * `null` means "could not be read", `{}` means "read, and the table is empty". The two must not
 * collapse into one value: the decisive check below is `owners[moved] === undefined`, so an
 * unreadable or corrupted store — or a plugin that stopped writing it — would otherwise report
 * success on exactly the regression this probe exists to catch. A missing file stays a
 * legitimate `{}` (nothing has been stored yet).
 */
const assignments = async () => {
  let text
  try {
    text = await readFile(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    console.log(`  (project_groups.json 无法读取: ${error.message})`)
    return null
  }
  try {
    return JSON.parse(text).tables?.assignments ?? {}
  } catch (error) {
    console.log(`  (project_groups.json 不是合法 JSON: ${error.message})`)
    return null
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

/** Click a group row's ＋ and wait for the tree to reflect whatever the click did. */
const clickPlus = async (row) => {
  await dismiss()
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await row.locator('button[aria-label^="在"]').first().dispatchEvent('click')
  await waitForRowsToSettle('＋ 之后')
}

try {
  // 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
  // 进程存活但从不监听端口 —— 那时下面的 boot 等到的只是一条误导性的超时。
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: 'pg' })
  if (prepared.problem !== undefined) {
    console.error(`无法准备探针环境：${prepared.problem}`)
    process.exit(2)
  }
  const url = await boot()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Both of these need a live `page`, so they run here and not at module scope: at module scope
  // they executed against an undefined `page` and threw before the probe had done anything.
  page.on('console', (message) => { if (message.type() === 'error') logs.push(message.text()) })
  await installRowKeyHelpers(page)
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
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
    moved !== undefined && ownersAfterPlus?.[moved]?.projectId !== undefined,
    JSON.stringify(ownersAfterPlus))

  // Step 2 is only meaningful with a Session to track. Reporting its three checks anyway would
  // add three FAILs that all restate the missing precondition and say nothing about ownership,
  // so the skip is stated once, explicitly, next to the state that was actually read.
  if (moved === undefined) {
    console.log('SKIP  未分组的 ＋：步骤 1 没有产出可追踪的 Session（见上面的 FAIL）')
    console.log(`  读数: 甲=${JSON.stringify(alphaAfterPlus)} 未分组=${JSON.stringify(ungroupedAfterPlus)}`)
  } else {
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
    //
    // `owners !== null` is part of the condition on purpose: an unreadable store made
    // `owners[moved]` undefined for the wrong reason, which is the same value a correct
    // Ungrouped ＋ produces.
    check('the Ungrouped ＋ moved the Session under Ungrouped',
      ungroupedAfter.includes(moved),
      JSON.stringify({ moved, ungroupedAfter, alphaFinal }))
    check('and the Host holds no assignment for it',
      owners !== null && owners[moved] === undefined,
      JSON.stringify({ moved, owner: owners === null ? '<assignment table unreadable>' : owners[moved] ?? null }))
    check('the project no longer holds it',
      alphaFinal.length === 0, JSON.stringify(alphaFinal))
  }

  console.log(`\nconsole errors: ${logs.length === 0 ? '(none)' : logs.slice(0, 5).join(' | ')}`)
} finally {
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
