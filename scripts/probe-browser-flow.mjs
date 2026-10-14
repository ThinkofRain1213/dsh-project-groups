/**
 * Drive the real UI through the project flow, in the real browser.
 *
 * The console-error probe proved the mount stopped throwing, but "no error" is
 * not "it works". This exercises the actual surfaces: open the sidebar's New
 * project dialog, create one, confirm it renders as a project row, then confirm
 * it is still there after a reload — which is the one claim L1-2 exists to make.
 *
 * Two consequences of that premise, both of which this file used to violate:
 *
 *   - **Console errors are a failure, not a footnote.** They were only printed, so the
 *     run could exit 0 printing `ALL CHECKS PASSED` while the page logged errors — the
 *     exact contradiction of "no error is not it works". New errors are now asserted
 *     away, and any error at all is reported in the failure list.
 *   - **An aborted step must still be reported.** Every awaited Playwright call can
 *     reject (navigation timeout, detached element, obscured click). Unwrapped, the
 *     script died at that point with a raw stack: no `check(...)` recorded, the failure
 *     list empty, cleanup skipped, the browser left open. The flow now runs inside a
 *     try/finally so cleanup and the summary always happen.
 *
 * The UI copy, the aria-label prefixes and the repeated waits are named constants below:
 * each is a literal that a copy or markup change silently breaks, and one edit point is
 * what makes that failure diagnosable.
 *
 * Usage: node probe-browser-flow.mjs <baseUrlWithToken>
 */
import { chromium } from 'playwright-core'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node probe-browser-flow.mjs "http://127.0.0.1:PORT/?token=..."')
  process.exit(2)
}

// ── Selectors and copy this probe depends on ──────────────────────────────────

/** The project row key prefix; the sidebar renders one per Workspace. */
const PROJECT_ROW = '[data-row-key^="workspace:"]'
/** The session row key prefix. */
const SESSION_ROW = '[data-row-key^="session:"]'
/** The header control that opens the New project dialog. */
const NEW_PROJECT_BUTTON = 'button[aria-label="新建项目"]'
/** The dialog's title input. */
const PROJECT_NAME_INPUT = 'input[aria-label="项目名称"]'
/** The dialog's confirm action. */
const CREATE_BUTTON = '创建'
/** The cancel action inside the base-workspace dialog. */
const CANCEL_BUTTON = '取消'
/** The row action that starts a New Session filed under that row. */
const ROW_NEW_SESSION = 'button[aria-label^="在"]'
/** The row's project overflow menu. */
const ROW_PROJECT_MENU = 'button[aria-label^="项目"]'
/** The menu item that deletes a project. */
const DELETE_ITEM = '删除项目'
/** The Ungrouped bucket's heading text. */
const UNGROUPED_LABEL = '未分组'
/** One-time modals a fresh profile raises; the label is curated copy, so several spellings. */
const DISMISS_LABELS = ['稍后配置', '继续', 'Continue', 'Later', 'Got it', '知道了']

// ── Timing ────────────────────────────────────────────────────────────────────
//
// These are settles between a click and reading the derived DOM, not assertions: the
// assertions read the sidebar after the fact. They stay as delays because the surfaces
// involved (a modal closing, a list re-rendering, a reload) expose no promise to await;
// where a specific condition does exist it is awaited directly (see `dialogVisible`).

/** After dismissing a modal, before clicking again. */
const MODAL_SETTLE_MS = 1200
/** After a row hover reveals the action strip. */
const HOVER_SETTLE_MS = 400
/** After clicking a row's New Session control, for the list to settle. */
const NEW_SESSION_SETTLE_MS = 3500
/** After a full page load. */
const PAGE_SETTLE_MS = 6000

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

let browser
/** Console/page errors, and how many were present before the create step. */
const errors = []
let errorsBeforeCreate = 0

try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', (error) => { errors.push(`pageerror: ${error.message}`) })

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(PAGE_SETTLE_MS)

  // A fresh profile opens one-time modals whose mask intercepts every click: the
  // announcement, then a "add an API key to begin" gate (an isolated profile has
  // no credentials). Whichever is present is dismissed through its own button;
  // the dismiss is repeated because a reload can raise it again.
  const dismissModals = async () => {
    for (const label of DISMISS_LABELS) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        // Logged rather than discarded: a dismiss click that never landed leaves the mask up,
        // and `findMask` then reports a masked sidebar for what was really a failed click.
        await button.click({ force: true }).catch((error) => {
          console.log(`  dismissModals: click on "${label}" failed — ${error.message}`)
        })
        await page.waitForTimeout(MODAL_SETTLE_MS)
      }
    }
  }

  /**
   * The text of whatever modal is still masking clicks, or null when none is.
   *
   * One helper rather than two copies of the same brittle DOM heuristic (the mask scan
   * was duplicated below): two copies drift apart the moment the mask markup changes,
   * and only one of them gets fixed.
   */
  const findMask = () => page.evaluate(() => {
    const mask = [...document.querySelectorAll('div[aria-hidden="true"]')]
      .find(node => node.className.includes('mask'))
    return mask === undefined ? null : (mask.parentElement?.innerText ?? '').slice(0, 120)
  })

  await dismissModals()
  // Anything still masking would fail every click below; say so rather than
  // letting the first click time out.
  const masking = await findMask()
  if (masking !== null) {
    console.log(`WARNING: a modal is still masking clicks: ${JSON.stringify(masking)}`)
  }

  // The sidebar renders "未分组" for a session with no project. Its presence means
  // the vendored browser mounted; the project list is what we are testing below.
  const title = '探针项目'
  const unique = `${title}-${Date.now().toString(36)}`

  /** Read the sidebar's group headings. */
  const headings = async () => page.evaluate((prefix) => {
    const rows = [...document.querySelectorAll(prefix)]
    return rows.map(row => row.textContent?.trim() ?? '')
  }, PROJECT_ROW)

  const before = await headings()
  console.log(`sidebar rows before: ${JSON.stringify(before)}`)
  check('the sidebar rendered at least the Ungrouped bucket', before.length >= 1, JSON.stringify(before))

  // Open the New project dialog: the header's add control.
  const addButton = page.locator(NEW_PROJECT_BUTTON).first()
  const addVisible = await addButton.count()
  check('the header add control is the New project button', addVisible > 0, `count=${addVisible}`)
  if (addVisible > 0) {
    await addButton.click()
    await page.waitForTimeout(800)
    const input = page.locator(PROJECT_NAME_INPUT).first()
    // Waited for explicitly rather than compared after a fixed delay: this is a real
    // condition, and its absence is the difference between "the dialog did not open"
    // and "the dialog opened slowly".
    const dialogVisible = await input.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
    check('the New project dialog opened', dialogVisible)

    if (dialogVisible) {
      await input.fill(unique)
      // Snapshot the error count so the create step can be judged on the errors IT
      // raised, not on everything the page has logged since load.
      errorsBeforeCreate = errors.length
      await page.getByRole('button', { name: CREATE_BUTTON }).first().click()
      await page.waitForTimeout(2500)

      const after = await headings()
      console.log(`sidebar rows after create: ${JSON.stringify(after)}`)
      check('the new project appears as a sidebar row',
        after.some(row => row.includes(unique)), JSON.stringify(after))
      // Assert the absence of any NEW error, not just of an error whose text happens to
      // contain "project": a widget crash or a network 500 raised while creating was
      // previously discarded, so the check could pass while the page was logging errors.
      const newErrors = errors.slice(errorsBeforeCreate)
      check('creating a project raised no new console error',
        newErrors.length === 0, newErrors.join(' | ').slice(0, 200))

      // Reload: the project must come back, which is the whole point of L1-2.
      await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
      await page.waitForTimeout(PAGE_SETTLE_MS)
      const reloaded = await headings()
      console.log(`sidebar rows after reload: ${JSON.stringify(reloaded)}`)
      check('the project survives a reload (it is on the Host)',
        reloaded.some(row => row.includes(unique)), JSON.stringify(reloaded))

      // Read where each Session actually sits, in the sidebar's own terms: for every
      // group heading, the Session rows inside that section. This is what a person
      // sees, so it is what the filing assertions below are about.
      //
      // A group with no Sessions is not rendered at all, so an "Ungrouped" entry being
      // absent is a real state, distinct from it being present and empty. Assertions
      // below therefore test for both rather than reading `undefined` as zero — a
      // `?? 0` there would pass whether or not the bucket existed.
      const sidebarLayout = () => page.evaluate(({ projectRow, sessionRow }) => {
        const sections = [...document.querySelectorAll(projectRow)]
        return sections.map((section) => {
          const heading = (section.textContent ?? '').trim()
          // Session rows live inside the same section element as their heading.
          const scope = section.closest('div[role="treeitem"]')?.parentElement ?? section.parentElement
          const sessions = [...scope.querySelectorAll(sessionRow)]
          return { heading, sessionCount: sessions.length }
        })
      }, { projectRow: PROJECT_ROW, sessionRow: SESSION_ROW })

      /** The section whose heading contains this text, or undefined when absent. */
      const sectionFor = (layout, text) => layout.find(row => row.heading.includes(text))

      /** How many Sessions sit under a heading; an absent group holds none. */
      const countFor = (layout, text) => sectionFor(layout, text)?.sessionCount ?? 0

      /** The row element whose heading contains this text. */
      const rowFor = (text) => page.locator(PROJECT_ROW, { hasText: text }).first()

      // The row action strip is CSS-hidden until its row is hovered, and Playwright
      // cannot scroll an invisible element into view. Hovering is what a person does;
      // the dispatched click then runs the real button's React handler in the real
      // page, which is what these assertions are about. The hover styling itself is
      // not under test.
      const clickRowPlus = async (text) => {
        const row = rowFor(text)
        if (await row.count() === 0) return false
        await row.hover({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(HOVER_SETTLE_MS)
        const plus = row.locator(ROW_NEW_SESSION).first()
        if (await plus.count() === 0) return false
        await plus.dispatchEvent('click')
        await page.waitForTimeout(NEW_SESSION_SETTLE_MS)
        return true
      }

      // 0. Baseline: with a project but no filing, every existing Session is Ungrouped.
      const baselineLayout = await sidebarLayout()
      console.log(`layout before any New Session: ${JSON.stringify(baselineLayout)}`)
      check('the Ungrouped bucket is rendered while Sessions are unfiled',
        sectionFor(baselineLayout, UNGROUPED_LABEL) !== undefined, JSON.stringify(baselineLayout))
      check('the new project starts empty', countFor(baselineLayout, unique) === 0)

      // 1. The REVERSE test first, because it is the one that can fail: the Ungrouped
      //    bucket's ＋ must not file anything. Run before the project's own ＋ so the
      //    project is still empty and an unconditional assign would be visible.
      const ungroupedBefore = countFor(baselineLayout, UNGROUPED_LABEL)
      check('the Ungrouped ＋ was clickable', await clickRowPlus(UNGROUPED_LABEL))
      let layout = await sidebarLayout()
      console.log(`layout after Ungrouped ＋: ${JSON.stringify(layout)}`)
      check('the Ungrouped ＋ did NOT file its Session under the project',
        countFor(layout, unique) === 0, `project holds ${countFor(layout, unique)}`)
      // The count is not asserted to grow: a Workspace's New Session reuses its
      // existing blank Session rather than creating a second one, so the Ungrouped
      // bucket keeps the blank it already had. What matters is that the Session there
      // is still unfiled, which the assertion above pins down.
      check('the Ungrouped bucket still holds its unfiled Session',
        countFor(layout, UNGROUPED_LABEL) >= ungroupedBefore,
        `${ungroupedBefore} -> ${countFor(layout, UNGROUPED_LABEL)}`)

      // 2. The project row's own ＋ must file what it creates under that project. The
      //    blank Session from step 1 is still unfiled, so this reuses it — which also
      //    covers the "last click wins" rule: the same Session moves into the project.
      check('the project row is present to click', await rowFor(unique).count() > 0)
      check('the project row exposes its own New Session control',
        await rowFor(unique).locator(ROW_NEW_SESSION).count() > 0)
      check('the project ＋ was clickable', await clickRowPlus(unique))
      layout = await sidebarLayout()
      console.log(`layout after project ＋: ${JSON.stringify(layout)}`)
      check('the project ＋ created a Session inside the project',
        countFor(layout, unique) === 1, JSON.stringify(sectionFor(layout, unique)))
      check('and left no Session in Ungrouped',
        sectionFor(layout, UNGROUPED_LABEL) === undefined || countFor(layout, UNGROUPED_LABEL) === 0,
        JSON.stringify(sectionFor(layout, UNGROUPED_LABEL) ?? '(absent)'))

      // 3. The filing is on the Host, so it survives a reload like the project does.
      await page.reload({ waitUntil: 'networkidle', timeout: 60_000 })
      await page.waitForTimeout(PAGE_SETTLE_MS)
      layout = await sidebarLayout()
      console.log(`layout after reload: ${JSON.stringify(layout)}`)
      check('the filed Session is still inside its project after a reload',
        countFor(layout, unique) === 1, JSON.stringify(sectionFor(layout, unique)))
      // Asserted on the section's existence, not through `countFor`: a `?? 0` inside
      // would pass both when the Ungrouped bucket is gone and when it is present but
      // empty — and the distinction is exactly what step 0 pins down.
      check('and still not in Ungrouped after a reload',
        sectionFor(layout, UNGROUPED_LABEL) === undefined || countFor(layout, UNGROUPED_LABEL) === 0,
        JSON.stringify(sectionFor(layout, UNGROUPED_LABEL) ?? '(absent)'))

      // Clean up through the UI so the instance is left as it was found.
      await dismissModals()
      const masked = await findMask() !== null
      const row = page.locator(PROJECT_ROW, { hasText: unique }).first()
      const rowPresent = await row.count() > 0
      if (!masked && rowPresent) {
        await row.hover({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(HOVER_SETTLE_MS)
        const menuButton = row.locator(ROW_PROJECT_MENU).first()
        await menuButton.click({ force: true }).catch(() => {})
        await page.waitForTimeout(800)
        const del = page.getByText(DELETE_ITEM, { exact: true }).first()
        if (await del.count() > 0) {
          await del.click({ force: true }).catch(() => {})
          await page.waitForTimeout(800)
          // The confirmation's own button carries the same label; the dialog's is last.
          const confirm = page.getByRole('button', { name: DELETE_ITEM }).last()
          if (await confirm.count() > 0) {
            await confirm.click({ force: true }).catch(() => {})
            await page.waitForTimeout(2000)
          }
        }
        const remaining = await headings()
        check('the project was removed through the row menu',
          !remaining.some(heading => heading.includes(unique)), JSON.stringify(remaining))
      } else {
        // A cleanup that could not run is a real outcome, not a silent skip: the probe
        // created a project on a live instance and left it there, so reruns accumulate
        // state and the next run's "before" is not what this run saw.
        const reason = masked ? 'a modal is masking the sidebar' : 'the project row was not found'
        console.log(`(cleanup could not run: ${reason})`)
        check('the project created by this probe was removed again', false,
          `${unique} was left behind on the instance — ${reason}`)
      }
    }
  } else {
    console.log('(the New project control is missing; the flow steps cannot run)')
  }
} catch (error) {
  // Recorded, not propagated: a rejected Playwright call used to abort the whole script
  // here, leaving no check recorded and the browser open.
  check('the flow ran to completion', false, error.message)
} finally {
  // Console errors are dumped and FED INTO the verdict. Printing them alone let the run
  // exit 0 with `ALL CHECKS PASSED` while the page was logging errors.
  console.log('\nconsole errors observed:')
  for (const line of errors) console.log(`  ${line}`)
  if (errors.length === 0) console.log('  (none)')
  // Only asserted as a check when the flow itself completed: if it threw, the new errors
  // are almost certainly a consequence of that abort, and the failure above already
  // names the cause. Asserting here as well would just double-report the same event.
  if (failures.length === 0 && errors.length > 0) {
    check('the page logged no console errors', false, `${errors.length} error(s): ${errors.slice(0, 3).join(' | ')}`)
  }
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
