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
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-plugin-toggle.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = 17641
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Boot one profile on the fixed port; resolves once its URL is printed. */
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
        // A beat for the client bundles to finish serving.
        setTimeout(() => resolve({ child, url: match[1] }), 3000)
      }
    })
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${profile} exited early with ${code}: ${out.slice(-400)}`))
    })
  })
}

/** Stop a booted instance and wait for the port to be released. */
async function stop(child) {
  child.kill()
  await new Promise(resolve => setTimeout(resolve, 4000))
}

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

const sections = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key^="workspace:"]')]
  .map(node => ({
    heading: (node.textContent ?? '').trim(),
    expanded: node.getAttribute('aria-expanded'),
    key: node.getAttribute('data-row-key')?.replace('workspace:', ''),
  })))

let on
try {
  // --- Phase 1: plugin ON, create a project and expand it -------------------
  console.log('=== phase 1: plugin on, create and expand a project ===')
  on = await boot('pg')
  await page.goto(on.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(6000)
  await dismissModals()

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
  check('the project key is NOT in the shared view store',
    shared !== null && !shared.includes(row?.key), JSON.stringify(shared))
  await stop(on.child)

  // --- Phase 2: plugin OFF — the official sidebar mounts and prunes ---------
  console.log('\n=== phase 2: plugin off, official sidebar mounts on the same port ===')
  const off = await boot('official')
  await page.goto(off.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismissModals()
  const officialSections = await sections()
  console.log(`official sections: ${JSON.stringify(officialSections)}`)
  check('the official sidebar mounted (our project rows are gone)',
    !officialSections.some(section => section.heading.includes(unique)),
    JSON.stringify(officialSections.map(s => s.heading)))
  await stop(off.child)

  // --- Phase 3: plugin ON again — the expansion must come back --------------
  console.log('\n=== phase 3: plugin on again, the row must return expanded ===')
  on = await boot('pg')
  await page.goto(on.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismissModals()
  const restored = await sections()
  console.log(`sections: ${JSON.stringify(restored)}`)
  const back = restored.find(section => section.heading.includes(unique))
  check('the project row is back', back !== undefined, JSON.stringify(restored.map(s => s.heading)))
  check('and it came back EXPANDED, not collapsed', back?.expanded === 'true',
    `aria-expanded=${back?.expanded}`)
} finally {
  if (on?.child !== undefined && on.child.exitCode === null) await stop(on.child)
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
