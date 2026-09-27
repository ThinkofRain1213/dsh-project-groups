/**
 * Is the cross-group drop highlight confined to a group's header row?
 *
 * It used to hang on the group **section**. The section is taller than its
 * children — it owns the 2px `margin-top` between each pair — so a pointer in one
 * of those gaps was inside the section but inside no row, and the whole group lit
 * up. That is the flash seen while dragging past a project.
 *
 * The discriminating position is therefore the **2px gap between the header and
 * the first row**: the section covers it, no row does. A gap between two Session
 * rows is *not* discriminating — both builds leave it clear, because a session
 * row's own handler stops the event before the section sees it.
 *
 * Usage: node probe-drop-highlight.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
const PORT = 17657
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

const sessionsUnder = (title) => page.evaluate((text) => {
  const section = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .find(node => (node.textContent ?? '').includes(text))
  if (section === undefined) return []
  const scope = section.closest('div[class*="groupSection"]') ?? section.parentElement
  return [...scope.querySelectorAll('[data-row-key^="session:"]')]
    .map(node => node.getAttribute('data-row-key').replace('session:', ''))
}, title)

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()
const groupSection = (title) => projectRow(title).locator('xpath=ancestor::div[contains(@class,"groupSection")]')

const seed = async (title, message) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await dismiss()
    const row = projectRow(title)
    await row.hover({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(400)
    await row.locator('button[aria-label^="在"]').first().dispatchEvent('click')
    await page.waitForTimeout(3500)
    const composer = page.locator('[data-composer-input="true"]').first()
    if (await composer.count() === 0) continue
    await composer.click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
    await composer.type(message, { delay: 30 }).catch(() => {})
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
    for (let wait = 0; wait < 20; wait += 1) {
      await page.waitForTimeout(700)
      const named = await page.evaluate((text) => [...document.querySelectorAll('[data-row-key^="session:"]')]
        .some(node => (node.textContent ?? '').includes(text)), message)
      if (named) return
    }
  }
  throw new Error(`could not seed "${message}"`)
}

/** Which elements currently carry the cross-group highlight. */
const highlighted = () => page.evaluate(() => [...document.querySelectorAll('[class*="groupDropTarget"]')]
  .map(node => ({
    key: node.getAttribute('data-row-key'),
    cls: String(node.className).slice(0, 60),
  })))

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  const stamp = Date.now().toString(36)
  const alpha = `甲${stamp}`
  const beta = `乙${stamp}`
  for (const title of [alpha, beta]) {
    await dismiss()
    await page.locator('button[aria-label="新建项目"]').first().click()
    await page.waitForTimeout(800)
    await page.locator('input[aria-label="项目名称"]').first().fill(title)
    await page.getByRole('button', { name: '创建' }).first().click()
    await page.waitForTimeout(2500)
  }
  // Two rows in each: the target needs two so it has a last row to aim below, and
  // the source needs two so it still has a row after one is dragged away.
  await seed(alpha, 'alpha-one')
  await seed(alpha, 'alpha-two')
  await seed(beta, 'beta-one')
  await seed(beta, 'beta-two')

  const alphaRows = await sessionsUnder(alpha)
  const betaRows = await sessionsUnder(beta)
  console.log(`甲 rows: ${JSON.stringify(alphaRows)}`)
  console.log(`乙 rows: ${JSON.stringify(betaRows)}`)
  check('the source project holds two rows', alphaRows.length === 2, JSON.stringify(alphaRows))
  check('the target project holds two rows', betaRows.length === 2, JSON.stringify(betaRows))

  // Drag 甲's row toward 乙, pausing over the positions that matter.
  //
  // Geometry is measured **after** the drag starts, not before: starting a drag
  // flips `AnimatedRows ready` to false (it is `!nativeDragActive`), which can
  // shift the rows. Coordinates captured beforehand are stale, and a stale aim
  // point silently lands somewhere harmless — making a check pass on a build where
  // the behaviour is wrong.
  const source = groupSection(alpha).locator('[data-row-key^="session:"]').nth(0)
  const sourceBox = await source.boundingBox()
  if (sourceBox === null) throw new Error('source is not laid out')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 8, sourceBox.y + sourceBox.height / 2 + 8, { steps: 4 })
  await page.waitForTimeout(400)

  const betaHeader = projectRow(beta)
  const betaBox = await betaHeader.boundingBox()
  if (betaBox === null) throw new Error('target is not laid out after drag start')

  // (a) 乙's header row — the intended target, reached with a real pointer. Run
  // first: a synthetic event dispatched later would leave the drag bookkeeping in
  // a state a real pointer move then does not recover from.
  //
  // Approached in two stages. Starting a drag disables the list's row animation
  // (`AnimatedRows ready={!nativeDragActive}`), which shifts the rows, so a box
  // measured before the first move into 乙 is already stale on arrival. The first
  // move settles the layout; the box is then re-measured and the pointer placed on
  // the header's real centre.
  await page.mouse.move(betaBox.x + betaBox.width / 2, betaBox.y + betaBox.height / 2, { steps: 12 })
  await page.waitForTimeout(700)
  const settledBox = await projectRow(beta).boundingBox()
  if (settledBox === null) throw new Error('target header is not laid out')
  await page.mouse.move(settledBox.x + settledBox.width / 2, settledBox.y + settledBox.height / 2, { steps: 6 })
  await page.waitForTimeout(700)
  const onHeader = await highlighted()
  console.log(`highlight over 乙's header: ${JSON.stringify(onHeader)}`)

  // (b) THE discriminating check, and it is dispatched rather than aimed.
  //
  // The section is only 2px taller than its children per gap and the row below
  // overlaps all but one pixel of that, so a synthetic pointer cannot reliably
  // land in the band: an earlier version of this probe aimed at the computed
  // midpoint, actually hit the row, and passed on the broken build too.
  //
  // Dispatching `dragover` on the section element itself removes the ambiguity.
  // The broken build hangs the handler on the section, so the event sets the
  // highlight; the fixed build has no handler there, the event bubbles to the
  // document listener (which only `preventDefault`s), and nothing changes.
  const sectionOnly = await page.evaluate((title) => {
    const header = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
      .find(node => (node.textContent ?? '').includes(title))
    const section = header?.closest('div[class*="groupSection"]')
    if (section === undefined || section === null) return false
    const box = section.getBoundingClientRect()
    const event = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(box.left + box.width / 2),
      clientY: Math.round(box.top + 1),
      dataTransfer: new DataTransfer(),
    })
    section.dispatchEvent(event)
    return true
  }, beta)
  check('the section accepted a dispatched dragover', sectionOnly)
  await page.waitForTimeout(500)
  const onSection = await highlighted()
  console.log(`highlight after dispatching dragover on 乙's section: ${JSON.stringify(onSection)}`)

  // The highlight must be on the header **row** and never on the section. Asserting
  // "nothing is highlighted" would be wrong here — the pointer is still resting on
  // the header, so a header highlight is correct. What matters is *which element*
  // carries it: the old build put the class on the section (the whole-group flash),
  // the fixed one puts it on the row.
  check('the highlight appears on 乙\'s header ROW',
    onHeader.length === 1 && onHeader[0].key?.startsWith('workspace:') === true,
    JSON.stringify(onHeader))
  check('the group SECTION never carries the highlight',
    onSection.every(entry => entry.key?.startsWith('workspace:') === true),
    JSON.stringify(onSection))

  // Leaving the header must clear it — that is what stops a flash on the way past.
  const betaFirstRow = groupSection(beta).locator('[data-row-key^="session:"]').first()
  const betaRowBox = await betaFirstRow.boundingBox()
  if (betaRowBox !== null) {
    await page.mouse.move(betaRowBox.x + betaRowBox.width / 2, betaRowBox.y + betaRowBox.height / 2, { steps: 8 })
    await page.waitForTimeout(600)
    const afterLeave = await highlighted()
    console.log(`highlight after moving from the header onto 乙's row: ${JSON.stringify(afterLeave)}`)
    check('the header highlight clears when the pointer leaves it', afterLeave.length === 0,
      JSON.stringify(afterLeave))
  }

  await page.mouse.up()
  await page.waitForTimeout(2500)

  const alphaAfter = await sessionsUnder(alpha)
  const betaAfter = await sessionsUnder(beta)
  console.log(`甲 after: ${JSON.stringify(alphaAfter)}`)
  console.log(`乙 after: ${JSON.stringify(betaAfter)}`)
  // The pointer released on 乙's header, so the dragged row joins 乙.
  check('the drop into 乙 still worked',
    alphaAfter.length === 1 && betaAfter.length === 3 && betaAfter.includes(alphaRows[0]),
    JSON.stringify({ alphaAfter, betaAfter }))
} finally {
  child.kill()
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
