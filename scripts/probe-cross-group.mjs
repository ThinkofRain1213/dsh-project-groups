/**
 * Can a Session be dragged between groups?
 *
 * Two paths, and they mean different things:
 *
 *  - dropping on a **row** places the Session at that position and switches the
 *    view to manual ordering (upstream's rule for any sort gesture);
 *  - dropping on the **group itself** (its header, or its empty body) files the
 *    Session into that group without naming a position — under recency that
 *    stores nothing, because position comes from `updatedAt`.
 *
 * The shipped region supports neither: `compatibleTarget` requires the drag's
 * account to equal the group's, so a row in another group never even accepts the
 * event, and the group container only handles Workspace-row drags.
 *
 * Usage: node probe-cross-group.mjs <dshExe> <asarRoot> <dshHome>
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
  console.error('usage: node probe-cross-group.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

// Overridable: a Host leaked by an earlier failed run keeps this port bound, and the only
// symptom would be an opaque "boot timeout" instead of a clear collision.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17648)
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
    let timer
    // Every failure path kills the child before rejecting. `server` is only assigned once this
    // promise resolves, so the caller's `finally` cannot clean up a boot that never returned:
    // the orphaned Host would keep PORT bound and break every later run.
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
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (match !== null) { clearTimeout(timer); setTimeout(() => resolve({ child, url: match[1] }), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('exit', (code) => { fail(new Error(`${profile} exited with ${code}`)) })
  })
}

let browser
let page
const errors = []

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismissModals = () => dismissShared(page)

/** Session ids under one group heading, in rendered order. */
const sessionsUnder = (headingText) => page.evaluate((text) => {
  const section = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .find(node => (node.textContent ?? '').includes(text))
  if (section === undefined) return []
  const scope = section.closest('div[class*="groupSection"]') ?? section.parentElement
  return [...scope.querySelectorAll('[data-row-key^="session:"]')]
    .map(node => window.__sessionIdOf(node.getAttribute('data-row-key')) ?? '')
}, headingText)

/** The Ungrouped bucket's Session ids, in rendered order. */
const ungroupedSessions = () => page.evaluate(() => {
  const header = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .find(node => node.getAttribute('data-row-key') === 'workspace:')
  if (header === undefined) return null
  const scope = header.closest('div[class*="groupSection"]') ?? header.parentElement
  return [...scope.querySelectorAll('[data-row-key^="session:"]')]
    .map(node => window.__sessionIdOf(node.getAttribute('data-row-key')) ?? '')
})

/** The persisted ordering mode. */
const orderMode = () => page.evaluate(() => {
  const raw = localStorage.getItem('dsh.workspace.view.v5')
  if (raw === null) return null
  // A stale/corrupted value used to escape as a raw SyntaxError and abort the run instead of
  // reporting a result for the mode check.
  try { return JSON.parse(raw).orderBy ?? null } catch { return '<unparseable>' }
})

/**
 * The Host's stored assignment + order records, read from the domain file.
 *
 * A missing file is a legitimate empty domain, but a read or parse failure is not: collapsing
 * the two made a corrupted/renamed file (or a wrong path) look like "the Host stored nothing",
 * and the assertions below then failed for a reason with no visible cause.
 */
const storedDomain = async () => {
  let text
  try {
    text = await readFile(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      check('the Host\'s domain file is readable', false, error.message)
      return { assignments: {}, orders: {}, unreadable: true }
    }
    return { assignments: {}, orders: {} }
  }
  try {
    const parsed = JSON.parse(text)
    return { assignments: parsed.tables?.assignments ?? {}, orders: parsed.tables?.orders ?? {} }
  } catch (error) {
    check('the Host\'s domain file is valid JSON', false, error.message)
    return { assignments: {}, orders: {}, unreadable: true }
  }
}

const projectSection = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()
const groupSectionOf = (title) => projectSection(title).locator('xpath=ancestor::div[contains(@class,"groupSection")]')

const makeProject = async (title) => {
  await dismissModals()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

/**
 * Create a Session inside a project through its ＋, and give it a message.
 *
 * Verified and retried, because a single send is flaky: the composer is a Lexical
 * editor that mounts with the new Session, and a `fill` that lands before it is
 * ready leaves the Session blank — which the next ＋ then reuses, so the probe
 * silently ends up with fewer rows than it asked for. Polling for the message to
 * appear as the row's title is what makes the seed deterministic.
 */
const seedSession = async (title, message) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await dismissModals()
    const row = projectSection(title)
    // The swallowed error is logged, not discarded: a covered/detached element or a bad
    // selector otherwise surfaces much later as an unexplained "could not seed a Session".
    await row.hover({ timeout: 5000 }).catch((error) => console.log(`  (hover 失败: ${error.message.split('\n')[0]})`))
    await page.waitForTimeout(400)
    await row.locator('button[aria-label^="在"]').first().dispatchEvent('click')
    await page.waitForTimeout(3500)

    const composer = page.locator('[data-composer-input="true"]').first()
    if (await composer.count() === 0) {
      console.log(`  (第 ${String(attempt + 1)} 次: 没有找到输入框，重试)`)
      continue
    }
    await composer.click({ force: true }).catch((error) => console.log(`  (点击输入框失败: ${error.message.split('\n')[0]})`))
    await page.waitForTimeout(600)
    // `type` dispatches real key events, which the editor's own state follows;
    // `fill` sets the DOM text without necessarily updating it.
    await composer.type(message, { delay: 30 }).catch((error) => console.log(`  (输入失败: ${error.message.split('\n')[0]})`))
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')

    // Wait for the message to become the row's title. Reaching that state is the whole
    // condition; `rows.length > before.length` was an extra clause that could never decide
    // anything, because the very next line returns on `named` alone.
    for (let wait = 0; wait < 20; wait += 1) {
      await page.waitForTimeout(700)
      const named = await page.evaluate((text) => [...document.querySelectorAll('[data-row-key^="session:"]')]
        .some(node => (node.textContent ?? '').includes(text)), message)
      if (named) return
    }
  }
  throw new Error(`could not seed a Session titled "${message}" in ${title}`)
}

/** Drag `source` onto `target`, aiming at the target's top edge. */
const dragOnto = async (source, target, position) => {
  const box = await target.boundingBox()
  if (box === null) throw new Error('target is not laid out')
  await source.dragTo(target, {
    targetPosition: position ?? { x: box.width / 2, y: 1 },
    timeout: 20_000,
  })
  await page.waitForTimeout(3000)
}

let server
try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // These three need a live `page` and therefore run here, not at module scope — at module
  // scope they executed against an undefined `page` and threw before anything was launched.
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })
  await installRowKeyHelpers(page)
  // 自举 profile：`plugin --profile <name> add` 建出的只是覆盖层，缺 cordis.yml 时
  // 进程存活但从不监听端口 —— 那时下面的 boot 等到的只是一条误导性的超时。
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: 'pg' })
  if (prepared.problem !== undefined) {
    console.error(`无法准备探针环境：${prepared.problem}`)
    process.exit(2)
  }
  server = await boot('pg')
  await page.goto(server.url, { waitUntil: 'networkidle', timeout: 60_000 })
  await settleOnboarding(page)
  await page.waitForTimeout(6000)
  await dismissModals()

  const stamp = Date.now().toString(36)
  const alpha = `甲-${stamp}`
  const beta = `乙-${stamp}`
  await makeProject(alpha)
  await makeProject(beta)

  // Two Sessions in 甲, one in 乙. A message each so they are not the reusable
  // blank, which is not draggable.
  await seedSession(alpha, 'a-one')
  await seedSession(alpha, 'a-two')
  await seedSession(beta, 'b-one')

  const alphaBefore = await sessionsUnder(alpha)
  const betaBefore = await sessionsUnder(beta)
  console.log(`甲 before: ${JSON.stringify(alphaBefore)}`)
  console.log(`乙 before: ${JSON.stringify(betaBefore)}`)
  check('甲 holds two Sessions', alphaBefore.length === 2, JSON.stringify(alphaBefore))
  check('乙 holds one Session', betaBefore.length === 1, JSON.stringify(betaBefore))
  if (alphaBefore.length !== 2 || betaBefore.length !== 1) throw new Error('bad seed')

  // The two projects' ids, taken from the Host's own table rather than from a count: the order
  // assertions below must name the project the drag targeted, because `length === 2` also
  // describes an unrelated leftover record from another run or profile.
  const ownerOf = (domain, sessionId) => domain.assignments[sessionId]?.projectId
  const seededOwners = await storedDomain()
  const alphaProjectId = ownerOf(seededOwners, alphaBefore[1])
  const betaProjectId = ownerOf(seededOwners, betaBefore[0])
  console.log(`项目 id: 甲=${JSON.stringify(alphaProjectId)} 乙=${JSON.stringify(betaProjectId)}`)
  // Stated as a precondition: every order assertion below is scoped to these ids, so a missing
  // id would silently weaken them instead of failing.
  check('前置：能从 Host 的归档表里读出甲/乙的项目 id',
    alphaProjectId !== undefined && betaProjectId !== undefined,
    JSON.stringify({ alphaProjectId, betaProjectId }))

  // ── Path B: drop 甲's first Session onto 乙's only row. ──
  // A positional drop files the Session AND places it, and selects manual.
  const modeBefore = await orderMode()
  await dragOnto(
    groupSectionOf(alpha).locator('[data-row-key^="session:"]').nth(0),
    groupSectionOf(beta).locator('[data-row-key^="session:"]').nth(0),
  )
  const alphaAfter = await sessionsUnder(alpha)
  const betaAfter = await sessionsUnder(beta)
  console.log(`甲 after row drop: ${JSON.stringify(alphaAfter)}`)
  console.log(`乙 after row drop: ${JSON.stringify(betaAfter)}`)
  check('the dragged Session left 甲', alphaAfter.length === 1 && alphaAfter[0] === alphaBefore[1],
    JSON.stringify(alphaAfter))
  check('and joined 乙', betaAfter.length === 2 && betaAfter.includes(alphaBefore[0]),
    JSON.stringify(betaAfter))
  check('the row drop put it before the row it was dropped on',
    betaAfter[0] === alphaBefore[0], JSON.stringify(betaAfter))

  const modeAfter = await orderMode()
  console.log(`ordering mode: ${JSON.stringify(modeBefore)} -> ${JSON.stringify(modeAfter)}`)
  check('a positional cross-group drop selects manual ordering', modeAfter === 'manual',
    JSON.stringify({ modeBefore, modeAfter }))

  const stored1 = await storedDomain()
  // The specific Session must be filed under 乙's project, not merely present:
  // a count-only assertion is satisfied by the seed itself and would pass on a
  // bundle where the drag did nothing.
  const moved = alphaBefore[0]
  check('the Host filed the dragged Session under 乙',
    ownerOf(stored1, moved) !== undefined
    && ownerOf(stored1, moved) === ownerOf(stored1, betaBefore[0]),
    JSON.stringify({ moved, owner: ownerOf(stored1, moved), betaRow: ownerOf(stored1, betaBefore[0]) }))
  check('and recorded 乙\'s order',
    betaProjectId !== undefined && Object.hasOwn(stored1.orders, betaProjectId),
    JSON.stringify({ betaProjectId, orders: Object.keys(stored1.orders) }))

  // ── Path A: drop 乙's Session onto 甲's HEADER (the group itself). ──
  // Under manual ordering this goes to the front, and no row is named.
  //
  // The assertions name the Session that moved rather than comparing counts: 甲
  // holds two and 乙 holds one both before and after a *failed* drag, so a
  // count-only check passes on a bundle where nothing happens at all.
  const headerMoving = (await sessionsUnder(beta))[0]
  await dragOnto(
    groupSectionOf(beta).locator('[data-row-key^="session:"]').nth(0),
    projectSection(alpha),
    { x: 40, y: 4 },
  )
  const alphaHeader = await sessionsUnder(alpha)
  const betaHeader = await sessionsUnder(beta)
  console.log(`甲 after header drop: ${JSON.stringify(alphaHeader)}`)
  console.log(`乙 after header drop: ${JSON.stringify(betaHeader)}`)
  check('the header drop moved the Session into 甲',
    alphaHeader.includes(headerMoving) && !betaHeader.includes(headerMoving),
    JSON.stringify({ headerMoving, alphaHeader, betaHeader }))
  check('and placed it at the front (manual mode names no other position)',
    alphaHeader[0] === headerMoving, JSON.stringify(alphaHeader))
  // Read once: this assertion used to await `storedDomain()` three times, so the two sides of
  // the comparison and the diagnostic came from three different file snapshots.
  const storedAfterHeader = await storedDomain()
  // The right-hand side used to be `ownerOf(storedAfterHeader, alphaProjectId)` — a **project** id
  // passed where a **session** id belongs. That lookup is always `undefined`, so the assertion only
  // passed when the moving Session was *also* unfiled, i.e. exactly when the drag had failed.
  // It went unnoticed because this probe could not run at all (the profile had no `cordis.yml`);
  // the whole file aborted before reaching here. The comparison now uses a Session known to belong
  // to 甲 — `alphaBefore[1]` is the one the row-drop above left behind.
  const alphaAnchor = alphaBefore[1]
  check('and the Host filed it under 甲',
    ownerOf(storedAfterHeader, headerMoving) !== undefined
    && ownerOf(storedAfterHeader, headerMoving) === ownerOf(storedAfterHeader, alphaAnchor),
    JSON.stringify({
      headerMoving,
      owner: ownerOf(storedAfterHeader, headerMoving),
      alphaAnchor,
      alphaAnchorOwner: ownerOf(storedAfterHeader, alphaAnchor),
      alphaProjectId,
      domain: storedAfterHeader,
    }))

  // ── Drag out to Ungrouped, which must be reachable even when empty. ──
  const ungroupedBefore = await ungroupedSessions()
  console.log(`未分组 before: ${JSON.stringify(ungroupedBefore)}`)
  check('the Ungrouped bucket renders even with nothing loose', ungroupedBefore !== null,
    JSON.stringify(ungroupedBefore))
  await dragOnto(
    groupSectionOf(alpha).locator('[data-row-key^="session:"]').nth(0),
    page.locator('[data-row-key="workspace:"]').first(),
    { x: 40, y: 4 },
  )
  const alphaOut = await sessionsUnder(alpha)
  const ungroupedAfter = await ungroupedSessions()
  console.log(`甲 after drag-out: ${JSON.stringify(alphaOut)}`)
  console.log(`未分组 after drag-out: ${JSON.stringify(ungroupedAfter)}`)
  check('the Session left 甲 for Ungrouped',
    alphaOut.length === 1 && (ungroupedAfter ?? []).includes(alphaBefore[0]),
    JSON.stringify({ alphaOut, ungroupedAfter }))

  const stored2 = await storedDomain()
  // `unreadable` is part of the condition: an unreadable store reports the same `undefined` a
  // correct drag-out produces, so without it a broken read passes the check.
  check('the Host dropped the assignment on the way out',
    stored2.unreadable !== true && stored2.assignments[alphaBefore[0]] === undefined,
    JSON.stringify(stored2.assignments))

  // ── Everything survives a reload. ──
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismissModals()
  const alphaReload = await sessionsUnder(alpha)
  const ungroupedReload = await ungroupedSessions()
  console.log(`甲 after reload: ${JSON.stringify(alphaReload)}`)
  console.log(`未分组 after reload: ${JSON.stringify(ungroupedReload)}`)
  check('ownership and position survive a reload',
    alphaReload.length === 1 && (ungroupedReload ?? []).includes(alphaBefore[0]),
    JSON.stringify({ alphaReload, ungroupedReload }))

  // ── A header drop under RECENCY must store no order. ──
  // Recency means "position comes from `updatedAt`", so there is nothing to
  // record: the Session is filed and lands by time. Storing a position here would
  // freeze a project the user never sorted.
  const switchMode = async (label) => {
    await dismissModals()
    await page.locator('button[aria-label="视图选项"]').first().click({ force: true })
    await page.waitForTimeout(800)
    await page.getByRole('menuitem', { name: label }).first().click({ force: true })
    await page.waitForTimeout(2000)
  }
  await switchMode('最近更新')
  const modeRecency = await orderMode()
  const domainAfterDiscard = await storedDomain()
  console.log(`mode for the recency phase: ${JSON.stringify(modeRecency)}; orders: ${JSON.stringify(Object.keys(domainAfterDiscard.orders))}`)
  // Named per project instead of "no order records at all": an unrelated leftover record from
  // another run would have failed a count-based check for a reason that has nothing to do with
  // this switch. The two projects here are the ones that had orders a moment ago.
  check('switching back to recency discards the orders',
    domainAfterDiscard.unreadable !== true
    && alphaProjectId !== undefined && betaProjectId !== undefined
    && !Object.hasOwn(domainAfterDiscard.orders, alphaProjectId)
    && !Object.hasOwn(domainAfterDiscard.orders, betaProjectId),
    JSON.stringify({ alphaProjectId, betaProjectId, orders: Object.keys(domainAfterDiscard.orders) }))

  const loose = await ungroupedSessions()
  const betaBeforeHeader = await sessionsUnder(beta)
  await dragOnto(
    page.locator('[data-row-key="workspace:"]').first().locator('xpath=ancestor::div[contains(@class,"groupSection")]')
      .locator('[data-row-key^="session:"]').nth(0),
    projectSection(beta),
    { x: 40, y: 4 },
  )
  const betaAfterHeader = await sessionsUnder(beta)
  const modeStill = await orderMode()
  const domainAfterHeader = await storedDomain()
  console.log(`乙 after recency header drop: ${JSON.stringify(betaAfterHeader)}`)
  console.log(`mode after: ${JSON.stringify(modeStill)}; orders: ${JSON.stringify(Object.keys(domainAfterHeader.orders))}`)
  check('a header drop under recency still files the Session',
    betaAfterHeader.length === betaBeforeHeader.length + 1 && betaAfterHeader.includes(loose[0]),
    JSON.stringify({ betaBeforeHeader, betaAfterHeader, loose }))
  check('and does NOT switch the mode to manual', modeStill === 'updated', String(modeStill))
  // Scoped to the target project: "the orders table is empty" is a different (and weaker)
  // claim, and it was satisfied by a table that an unrelated record happened to leave alone.
  check('and stores no order for the target project',
    domainAfterHeader.unreadable !== true && betaProjectId !== undefined
    && !Object.hasOwn(domainAfterHeader.orders, betaProjectId),
    JSON.stringify({ betaProjectId, orders: Object.keys(domainAfterHeader.orders) }))

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
