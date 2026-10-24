/**
 * Does a project's expansion survive the plugin being switched off and on?
 *
 * That is the reported failure, and it is not the same as a page reload. The
 * official plugin and this one persist to the **same** localStorage key
 * (`dsh.workspace.view.v5`), and the official mount calls `retainAccountKeys`
 * with the Workspace ids only — pruning every key that is not one. So a project's
 * expansion kept in that store is deleted the first time the official sidebar
 * mounts, which is exactly what switching this plugin off does.
 *
 * ## Why this probe owns the instance lifecycle
 *
 * localStorage is scoped to an **origin**, and an origin includes the port. Two
 * instances on different ports are two different origins that share nothing, so
 * a version of this probe that ran the two profiles side by side would never let
 * the official sidebar see the project's key — and would pass whether or not the
 * bug existed. (It did: the first version of this file was a false positive, and
 * a negative control against the pre-fix bundle caught it.)
 *
 * So the servers are booted **sequentially on one fixed port**, with a single
 * browser context kept open across all three phases. Same origin, same
 * localStorage, and the swap in between is a real plugin switch.
 *
 * Usage: node probe-plugin-toggle.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-plugin-toggle.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

// Overridable: a leaked instance from an earlier run keeps this port bound, and because the two
// profiles share localStorage only when they share the origin, a silent collision would make the
// whole three-phase design measure the wrong thing.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17641)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * The Host's own order records, read straight from this plugin's domain file.
 *
 * A missing file is a legitimate empty domain; a read or parse failure is not, and collapsing
 * the two made a corrupted file indistinguishable from "the record was pruned" — the exact
 * outcome these assertions are trying to detect.
 */
const storedOrders = async () => {
  let text
  try {
    text = await readFile(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') console.log(`  (project_groups.json 无法读取: ${error.message})`)
    return {}
  }
  try {
    return JSON.parse(text).tables?.orders ?? {}
  } catch (error) {
    console.log(`  (project_groups.json 不是合法 JSON: ${error.message})`)
    return {}
  }
}

/** Boot one profile on the fixed port; resolves once its URL is printed. */
function boot(profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    // `settled` stops every later stdout chunk from re-matching the accumulated output and
    // scheduling another 3 s timer: the URL was matched repeatedly and `resolve` re-queued each
    // time, leaving uncancellable timers behind for the rest of the run.
    let settled = false
    let timer
    const fail = (error) => {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      reject(error)
    }
    timer = setTimeout(() => fail(new Error(`timed out booting ${profile}: ${redactToken(out.slice(-400))}`)), 120_000)
    // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
    // stdout, so without this handler the promise stayed pending until the 120 s timeout and
    // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
    // the process outright.
    child.on('error', (error) => fail(new Error(`spawn failed for ${exe}: ${error.message}`)))
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      if (settled) return
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) {
        settled = true
        clearTimeout(timer)
        // A beat for the client bundles to finish serving.
        setTimeout(() => resolve({ child, url: match[1] }), 3000)
      }
    })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('exit', (code) => { fail(new Error(`${profile} exited early with ${code}: ${redactToken(out.slice(-400))}`)) })
  })
}

/**
 * Stop a booted instance and wait for it to actually exit.
 *
 * The next phase boots on the *same fixed port*, so a flat 4 s sleep that ends early leaves the
 * port occupied and the failure surfaces much later as an unrelated "boot timeout" in the next
 * phase — with nothing pointing at the real cause.
 */
async function stop(child) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => { child.once('exit', resolve) })
  child.kill()
  const released = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (released) {
    // A short grace for the OS to release the listening socket.
    await new Promise(resolve => setTimeout(resolve, 500))
  } else {
    console.log('  (警告: 进程 10s 内没有退出，端口可能仍被占用，下一阶段可能启动失败)')
  }
}

let browser
let page

const sections = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key^="workspace:"]')]
  .map(node => ({
    heading: (node.textContent ?? '').trim(),
    expanded: node.getAttribute('aria-expanded'),
    key: node.getAttribute('data-row-key')?.replace('workspace:', ''),
  })))

let on
// Declared beside `on`, not inside the try: a throw anywhere between `boot('official')` and its
// inline `stop` used to leave the official instance running on the fixed port, poisoning every
// later run of every probe that shares it.
let off
try {
  // 本探针**依次使用两个 profile**：`pg`（装本插件）与 `official`（官方侧栏）。
  // 两个都必须在第一次 boot 之前建好 —— 缺 `cordis.yml` 时它们都是「进程活着但不监听」，
  // 而本探针的第一阶段就会超时，让人以为插件加载失败。
  // `official` 传 `installPlugin: false`：它要的正是**没有**本插件的侧栏。
  const preparedPg = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: 'pg' })
  if (preparedPg.problem !== undefined) {
    console.error(`无法准备探针环境：${preparedPg.problem}`)
    process.exit(2)
  }
  const preparedOfficial = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: 'official', installPlugin: false })
  if (preparedOfficial.problem !== undefined) {
    console.error(`无法准备探针环境：${preparedOfficial.problem}`)
    process.exit(2)
  }

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // --- Phase 1: plugin ON, create a project and expand it -------------------
  console.log('=== phase 1: plugin on, create and expand a project ===')
  on = await boot('pg')
  await page.goto(on.url, { waitUntil: 'networkidle', timeout: 60_000 })
  // 每个阶段都是一次**新的页面加载**，而登录引导的关闭不持久 —— 所以这里每个阶段都要关一次。
  await settleOnboarding(page)

  const unique = `toggle-${Date.now().toString(36)}`
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(unique)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
  await page.locator('[data-row-key^="workspace:"]', { hasText: unique }).first().click()
  await page.waitForTimeout(1500)

  const expanded = await sections()
  const row = expanded.find(section => section.heading.includes(unique))
  console.log(`sections: ${JSON.stringify(expanded)}`)
  check('the project row exists and is expanded', row?.expanded === 'true', JSON.stringify(row))
  check('the project has an id to key its expansion on', row?.key !== undefined, String(row?.key))

  // The shared view store must NOT hold the project key: that is the whole point
  // of moving the state, and it is what makes the official prune harmless.
  const shared = await page.evaluate(() => {
    const raw = localStorage.getItem('dsh.workspace.view.v5')
    return raw === null ? null : Object.keys(JSON.parse(raw).groupExpansion ?? {})
  })
  console.log(`shared view store groupExpansion keys: ${JSON.stringify(shared)}`)
  // `row?.key !== undefined` is part of the condition: with no key to look for,
  // `shared.includes(undefined)` is false and the check PASSed without verifying anything.
  check('the project key is NOT in the shared view store',
    row?.key !== undefined && shared !== null && !shared.includes(row.key), JSON.stringify(shared))

  // Switch to manual ordering, which freezes every project into a stored order.
  // The record goes to this plugin's own domain, for the same reason the
  // expansion does: the official mount prunes the view store's non-Workspace
  // keys, and `retainAccountKeys` prunes `sessionOrderByAccount` as well.
  await page.locator('button[aria-label="视图选项"]').first().click({ force: true })
  await page.waitForTimeout(800)
  await page.getByRole('menuitem', { name: '手动排序' }).first().click({ force: true })
  await page.waitForTimeout(2500)

  const sharedOrders = await page.evaluate(() => {
    const raw = localStorage.getItem('dsh.workspace.view.v5')
    return raw === null ? null : Object.keys(JSON.parse(raw).sessionOrderByAccount ?? {})
  })
  const ownOrders = await storedOrders()
  console.log(`shared sessionOrderByAccount keys: ${JSON.stringify(sharedOrders)}`)
  console.log(`our own order records: ${JSON.stringify(Object.keys(ownOrders))}`)
  check('the project key is NOT in the shared sessionOrderByAccount',
    row?.key !== undefined && sharedOrders !== null && !sharedOrders.includes(row.key), JSON.stringify(sharedOrders))
  check('the frozen order is in this plugin\'s own domain',
    row?.key !== undefined && ownOrders[row.key] !== undefined, JSON.stringify(Object.keys(ownOrders)))
  await stop(on.child)

  // --- Phase 2: plugin OFF — the official sidebar mounts and prunes ---------
  console.log('\n=== phase 2: plugin off, official sidebar mounts on the same port ===')
  off = await boot('official')
  await page.goto(off.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  const officialSections = await sections()
  console.log(`official sections: ${JSON.stringify(officialSections)}`)
  check('the official sidebar mounted (our project rows are gone)',
    !officialSections.some(section => section.heading.includes(unique)),
    JSON.stringify(officialSections.map(s => s.heading)))
  await stop(off.child)
  // Marked stopped so the `finally` does not stop it a second time (and so it is obvious that
  // the phase-2 instance is now the `finally`'s responsibility until this point).
  off = undefined

  // --- Phase 3: plugin ON again — the expansion must come back --------------
  console.log('\n=== phase 3: plugin on again, the row must return expanded ===')
  on = await boot('pg')
  await page.goto(on.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  const restored = await sections()
  console.log(`sections: ${JSON.stringify(restored)}`)
  const back = restored.find(section => section.heading.includes(unique))
  check('the project row is back', back !== undefined, JSON.stringify(restored.map(s => s.heading)))
  check('and it came back EXPANDED, not collapsed', back?.expanded === 'true',
    `aria-expanded=${back?.expanded}`)

  // The frozen order must have survived the official mount too — it was written
  // to our own domain, so the prune had nothing of ours to delete.
  const modeBack = await page.evaluate(() => {
    const raw = localStorage.getItem('dsh.workspace.view.v5')
    return raw === null ? null : JSON.parse(raw).orderBy ?? null
  })
  const ordersBack = await storedOrders()
  console.log(`mode after the round trip: ${JSON.stringify(modeBack)}`)
  console.log(`order records after the round trip: ${JSON.stringify(Object.keys(ordersBack))}`)
  check('the ordering mode survived the plugin toggle', modeBack === 'manual', String(modeBack))
  check('and so did the project\'s frozen order',
    back !== undefined && ordersBack[back.key] !== undefined, JSON.stringify(Object.keys(ordersBack)))
} finally {
  // `off` is stopped here as well as inline: a throw in phase 2 would otherwise skip its inline
  // stop and leave the official instance holding the fixed port for every later run.
  if (off?.child !== undefined && off.child.exitCode === null) await stop(off.child)
  if (on?.child !== undefined && on.child.exitCode === null) await stop(on.child)
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
