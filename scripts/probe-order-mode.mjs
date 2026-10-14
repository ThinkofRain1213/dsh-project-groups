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
 * **Needs an empty `dshHome`.** It asserts the arriving state — no order records,
 * exactly one project — so pointing it at a profile another probe has already
 * written reports failures that are the leftover data, not the code. Give it its
 * own directory, or run it before anything else touches that one.
 *
 * Usage: node probe-order-mode.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-order-mode.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = Number(process.env.DSH_PROBE_PORT ?? 17646)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

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
    // The timeout rejects *after* reaping the child: the caller only receives the child on
    // success, so a boot failure that did not kill it here would leave an Electron Host
    // holding `PORT` for every later run of this probe.
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timed out booting ${profile}: ${redactToken(out.slice(-400))}`))
    }, 120_000)
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
      if (match !== null) { clearTimeout(timer); setTimeout(() => resolve({ child, url: match[1] }), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`${profile} exited with ${code}`)) })
  })
}

const errors = []
let browser
let page

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismissModals = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Continue', 'Later', 'Got it', '知道了']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        // Logged rather than swallowed: a click that fails keeps the mask up, and the mode
        // readings below would then be taken against the mask instead of the sidebar.
        await button.click({ force: true }).catch((error) => { console.log(`  取消失败（${label}）: ${error.message}`) })
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(800)
  }
}

/**
 * The view store's persistence key.
 *
 * The `v5` suffix is the store's own schema version, and this probe cannot import it (the
 * store lives in the client bundle). A version bump would make `getItem` return `null`,
 * which reads exactly like "no mode recorded" — so `orderMode()` reports the key it looked
 * for, and the manual-mode step prints the keys that do exist when it comes back null.
 */
const VIEW_STORE_KEY = 'dsh.workspace.view.v5'

/** The persisted ordering mode. */
const orderMode = () => page.evaluate((key) => {
  const raw = localStorage.getItem(key)
  return raw === null ? null : JSON.parse(raw).orderBy ?? null
}, VIEW_STORE_KEY)

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
    return JSON.parse(text)?.tables?.orders ?? {}
  } catch (error) {
    // Only a file that is not there yet (fresh install) means "no records". Swallowing every
    // error made a corrupt/unreadable domain look like an empty one, so the two checks below
    // passed vacuously — a false PASS over the data-integrity failure this probe exists to catch.
    if (error?.code === 'ENOENT') return {}
    throw new Error(`cannot read the Host's order records from ${join(dshHome, 'storages', 'project_groups.json')}: ${String(error?.message ?? error)}`)
  }
}

let server
try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Listeners are attached only once `page` exists: at module scope `page` was still
  // `undefined` and `page.on(...)` threw before anything else could run.
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })
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
  await projectRow.hover({ timeout: 5000 }).catch((error) => { console.log(`  悬停失败: ${error.message}`) })
  await page.waitForTimeout(400)
  await projectRow.locator('button[aria-label^="在"]').first().dispatchEvent('click')
  await page.waitForTimeout(3000)

  const mode0 = await orderMode()
  const orders0 = await storedOrders()
  console.log(`mode on arrival: ${JSON.stringify(mode0)}; stored orders: ${JSON.stringify(Object.keys(orders0))}`)
  // The header promises an empty `dshHome`, and only the order side of that promise was
  // asserted. A profile that already holds projects would freeze *those* too, so
  // 'a stored order' below would fail on leftover data while looking like a code failure —
  // hence this precondition, stated as one.
  // The ungrouped bucket also renders as a `workspace:` row (`workspace:` with an empty id), and
  // it is not a project: it carries no order record, so counting it would fail this precondition
  // on a pristine profile.
  const projectsOnArrival = await page.locator('[data-row-key^="workspace:"]:not([data-row-key="workspace:"])').count()
  check('前置：dshHome 里没有别的项目（脏 profile 会让下面的失败变成残留数据）',
    projectsOnArrival === 1,
    `项目行数=${String(projectsOnArrival)}（应只有本次创建的 1 个）`)
  check('a fresh install starts in recency mode', mode0 === 'updated', String(mode0))
  check('and stores no order records', Object.keys(orders0).length === 0, JSON.stringify(orders0))

  // Switching to manual must freeze every project, not just a dragged one.
  await pickOrderMode('手动排序')
  const mode1 = await orderMode()
  const orders1 = await storedOrders()
  console.log(`mode after picking manual: ${JSON.stringify(mode1)}; stored orders: ${JSON.stringify(orders1)}`)
  if (mode1 === null) {
    // A null here is either "the store never wrote" or "the store's key version moved on".
    // Print the keys that do exist so the two are told apart instead of both reading as a
    // mode assertion failing.
    const keys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('dsh.workspace.view.')))
    console.log(`  （视图存储键期望 ${VIEW_STORE_KEY}，实际存在 ${JSON.stringify(keys)}）`)
  }
  check('picking manual switches the mode', mode1 === 'manual', String(mode1))
  // The length is compared to the actual array, not through `?? -1`: a record with no
  // `sessionIds` at all is a different defect from the wrong count, and both must not
  // collapse into the same unreadable number.
  const frozen = Object.values(orders1)
  check('and freezes the project into a stored order',
    frozen.length === 1 && Array.isArray(frozen[0]?.sessionIds) && frozen[0].sessionIds.length === 1,
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
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
