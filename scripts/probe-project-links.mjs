/**
 * The associated-link surface: the debounced check, the switch, and what reaches the Host.
 *
 * ## What this covers, and why each part earns a probe
 *
 *   1. a project stored with links renders them in its edit dialog;
 *   2. **the debounced check itself** — typing shows a spinner, 0.5s of quiet produces a
 *      verdict, and the verdict differs for a URL and for free text. This is the part with
 *      **no official precedent** (measured: no component in the installed DSH validates an
 *      input as it is typed), so it is the part most likely to be wrong;
 *   3. the focus rule: a green check shows only while the row has focus, while the amber ⓘ
 *      stays after blur;
 *   4. the header count tracks the failing rows;
 *   5. the switch being off removes all four states;
 *   6. editing sends the new list to the Host, and **a non-URL is stored verbatim** — the
 *      marking must never become a gate;
 *   7. removing a row and reopening shows the stored list, not a leftover draft.
 *
 * ## Why the timing assertions are shaped as they are
 *
 * The 0.5s debounce means every verdict assertion has to wait past it, and a spinner
 * assertion has to read *before* it. Both are checked against the real clock rather than
 * mocked, because the whole point is that the shipped timer behaves.
 *
 * Usage: node probe-project-links.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-links.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17820 : 17821
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
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
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

let browser
let page
const consoleErrors = []
page.on('pageerror', (error) => consoleErrors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 8; i += 1) {
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

const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({
      type: 'client-request', rpcId: `p-${Math.random().toString(36).slice(2)}`,
      method, payload: { args },
    }),
  })
  const parsed = JSON.parse(await response.text())
  return { ok: parsed?.result?.ok, value: parsed?.result?.value, error: parsed?.result?.error }
}, { method, args })

/** The plugin's durable projects; the ground truth for "did it write". */
const storedProjects = () => {
  try {
    const parsed = JSON.parse(readFileSync(`${dshHome}/storages/project_groups.json`, 'utf8'))
    const table = parsed.tables?.projects ?? {}
    return (parsed.global?.projectIds ?? []).map(id => table[id]).filter(Boolean)
  } catch {
    return []
  }
}
const linksOf = (title) => storedProjects().find(p => p.title === title)?.links ?? []
/**
 * One project's id, by title.
 *
 * **The id is the table key, not a field on the value** — `storedProjects()` maps the values, so
 * reading `.projectId` off one of them yields `undefined` and the `update` that uses it is
 * rejected by the Host. Three call sites did exactly that and were silently no-ops; they only
 * looked harmless because the setup they were meant to perform happened to be already in place.
 */
const projectIdOf = (title) => {
  try {
    const table = JSON.parse(readFileSync(`${dshHome}/storages/project_groups.json`, 'utf8')).tables?.projects ?? {}
    return Object.entries(table).find(([, record]) => record.title === title)?.[0]
  } catch {
    return undefined
  }
}
/** Write a project's link list directly, asserting the Host accepted it. */
const setStoredLinks = async (title, links) => {
  const written = await rpc('projectGroups/update', {
    request: { projectId: projectIdOf(title), title, directories: [], links },
  })
  if (written.ok !== true) throw new Error(`update(${title}) 未成功 — ${String(written.error)}`)
  await page.waitForTimeout(1400)
}
const validateLinksSetting = () => {
  try {
    return JSON.parse(readFileSync(`${dshHome}/storages/project_groups.json`, 'utf8')).global?.validateLinks
  } catch {
    return undefined
  }
}

const dialogWith = (title) => page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: title }).first()

/** The link rows of one dialog. */
const linkRows = (dialog) => dialog.locator('ul li').filter({ has: page.locator('input[type="text"]') })
/** The link input of row `index` (0-based). */
const linkInput = (dialog, index) => linkRows(dialog).nth(index).locator('input[type="text"]')
/** The status mark of row `index`, if rendered. */
const statusOf = (dialog, index) => linkRows(dialog).nth(index).locator('span[class*="linkStatus"]')

/** Open one project row's edit dialog. */
const openEditDialog = async (title) => {
  const row = page.locator('[data-row-key^="workspace:"]').filter({ hasText: title }).first()
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  const trigger = row.locator(
    'button[aria-label*="项目"][aria-label*="操作"], button[aria-label*="更多"], button[aria-label*="菜单"]',
  ).first()
  if (await trigger.count() > 0) await trigger.click({ force: true })
  else await row.locator('button[aria-haspopup="menu"]').first().click({ force: true })
  await page.waitForTimeout(700)
  await page.getByRole('menuitem', { name: /编辑项目/ }).first().click({ force: true })
  await page.waitForTimeout(900)
  return dialogWith('编辑项目')
}

/**
 * Open a project's edit dialog **with a frame recorder already running**, so the dialog's first
 * moments are observable.
 *
 * {@link openEditDialog} waits 900ms before returning, which is longer than the check it would be
 * used to observe: a snapshot taken afterwards sees only the settled state and passes whatever
 * the first 500ms looked like. The recorder is installed before the menu item is clicked and
 * samples every animation frame — the same method 7g and 7i use, and the only one that sees a
 * state that exists for a single commit.
 * @param title - the project row to open.
 * @returns the dialog locator plus the `{ mark, count }` frames recorded while it opened.
 */
const openEditDialogRecorded = async (title) => {
  await page.evaluate(() => {
    const frames = []
    let raf = 0
    let last = ''
    const snap = () => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (dialog === null) return
      const status = dialog.querySelector('ul li span[class*="linkStatus"]')
      let mark = 'none'
      if (status !== null) {
        if (status.querySelector('svg[data-state="ongoing"]') !== null) mark = 'checking'
        else if (status.querySelector('[class*="linkInvalid"]') !== null) mark = 'invalid'
        else if (status.querySelector('[class*="linkValid"]') !== null) mark = 'valid'
      }
      const countNode = dialog.querySelector('[class*="linkInvalidCount"]')
      const frame = { mark, count: countNode === null ? null : countNode.textContent.trim() }
      const key = JSON.stringify(frame)
      if (key === last) return
      last = key
      frames.push(frame)
    }
    const loop = () => { snap(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    window.__openFrames = frames
    window.__openStop = () => cancelAnimationFrame(raf)
  })
  const dialog = await openEditDialog(title)
  const frames = await page.evaluate(() => {
    window.__openStop?.()
    return window.__openFrames ?? []
  })
  return { dialog, frames }
}

/** Which of the four marks a row is showing, read from what is inside its status span. */
const markOf = async (dialog, index) => {
  const status = statusOf(dialog, index)
  if (await status.count() === 0) return 'none'
  return await status.first().evaluate((node) => {
    if (node.querySelector('svg[data-state="ongoing"]') !== null) return 'checking'
    // The two icons are told apart by their colour class rather than by path data.
    if (node.querySelector('[class*="linkValid"]') !== null) return 'valid'
    if (node.querySelector('[class*="linkInvalid"]') !== null) return 'invalid'
    return 'unknown'
  })
}

let driverError
try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 准备：一个已存链接的项目 ===')
  const made = await rpc('projectGroups/create', {
    request: { title: 'linked', links: ['https://github.com/a/b'] },
  })
  check('带链接的项目已创建', made.ok, String(made.error))
  await page.waitForTimeout(2000)
  check('Host 确实存了链接',
    linksOf('linked').length === 1, JSON.stringify(linksOf('linked')))
  check('开关默认是开',
    validateLinksSetting() === true, String(validateLinksSetting()))

  console.log('')
  console.log('=== 1. 编辑对话框预填已存链接 ===')
  const edit = await openEditDialog('linked')
  check('1) 编辑对话框打开', await edit.count() > 0)
  check('1) 渲染出一行链接', await linkRows(edit).count() === 1, `rows=${String(await linkRows(edit).count())}`)
  check('1) 输入框里是已存的值',
    await linkInput(edit, 0).inputValue() === 'https://github.com/a/b',
    await linkInput(edit, 0).inputValue())

  console.log('')
  console.log('=== 2. 防抖校验：输入中→转圈，停 0.5s→出结果 ===')
  // Type a passing URL. The input is filled in one go, which is one change event; the
  // spinner must be visible before the debounce elapses and the check after it.
  await linkInput(edit, 0).click()
  await linkInput(edit, 0).fill('https://example.com/ok')
  // Read immediately: the timer is 0.5s, so this is safely inside the "checking" window.
  const during = await markOf(edit, 0)
  check('2) 输入后立刻是转圈', during === 'checking', during)
  await page.waitForTimeout(1200)
  const after = await markOf(edit, 0)
  check('2) 停手后变成绿勾', after === 'valid', after)

  console.log('')
  console.log('=== 3. 不通过：橙 ⓘ，且失焦后仍在；绿勾失焦即消失 ===')
  await linkInput(edit, 0).fill('not a url')
  await page.waitForTimeout(1200)
  const invalidFocused = await markOf(edit, 0)
  check('3) 自由文本是不通过', invalidFocused === 'invalid', invalidFocused)
  // Blur by focusing something else in the dialog.
  await edit.locator('input[type="text"]').first().evaluate(node => { node.blur() })
  await page.waitForTimeout(400)
  const invalidBlurred = await markOf(edit, 0)
  check('3) 失焦后橙 ⓘ 仍然在', invalidBlurred === 'invalid', invalidBlurred)

  // And the green check does the opposite: it must vanish on blur.
  await linkInput(edit, 0).click()
  await linkInput(edit, 0).fill('https://example.com/ok2')
  await page.waitForTimeout(1200)
  check('3) 聚焦时是绿勾', await markOf(edit, 0) === 'valid', await markOf(edit, 0))
  await edit.locator('input[type="text"]').first().evaluate(node => { node.blur() })
  await page.waitForTimeout(400)
  const validBlurred = await markOf(edit, 0)
  check('3) 失焦后绿勾消失', validBlurred === 'none', validBlurred)

  console.log('')
  console.log('=== 4. 标题行计数跟着走 ===')

  // The layout assertion comes FIRST, while the count is still zero, because that is the
  // only state that exposes it: the first version pushed the button right with
  // `margin-right: auto` on the count, so with nothing to report the button collapsed
  // against the label and only a warning state looked correct (reported from a screenshot).
  // Nothing here asserted positions, which is exactly why it shipped.
  const addButtonX = async () => (await edit.getByRole('button', { name: '添加链接' }).first()
    .boundingBox())?.x ?? -1
  const headerBox = async () => (await edit.locator('div[class*="linkHeader"]').first().boundingBox())
  const countBox = async () => (await edit.locator('[class*="linkInvalidCount"]').first().boundingBox())
  const labelBox = async () => (await edit.locator('span[class*="linkLabel"]').first().boundingBox())

  const beforeHeader = await headerBox()
  const beforeButton = await addButtonX()
  check('4) 无计数时添加链接已在右端',
    beforeHeader !== null && beforeButton > beforeHeader.x + beforeHeader.width / 2,
    `button.x=${String(beforeButton)} header.x=${String(beforeHeader?.x)} w=${String(beforeHeader?.width)}`)

  await linkInput(edit, 0).fill('bad one')
  await page.waitForTimeout(600)
  const withOne = (await edit.innerText()).replace(/\s+/g, ' ')
  check('4) 一条不合规时显示计数 1',
    withOne.includes('1 条链接未通过校验'), withOne.slice(0, 120))

  // ...and the count sits beside the label, while the button has not moved. Both halves
  // matter: "still right" alone would pass if the count had shoved the button, and "beside
  // the label" alone would pass if the button had drifted.
  const afterHeader = await headerBox()
  const afterButton = await addButtonX()
  const label = await labelBox()
  const count = await countBox()
  check('4) 有计数时按钮位置没变',
    Math.abs(afterButton - beforeButton) < 2,
    `${beforeButton} → ${afterButton}`)
  check('4) 计数紧贴标签右侧（不是被推到中间）',
    label !== null && count !== null
    && count.x > label.x + label.width - 2
    && count.x < label.x + label.width + 16,
    `label.x=${String(label?.x)} label.w=${String(label?.width)} count.x=${String(count?.x)} header.w=${String(afterHeader?.width)}`)

  // Add a second row and make it fail too, so the count is a real sum rather than a flag.
  await edit.getByRole('button', { name: '添加链接' }).first().click({ force: true })
  await page.waitForTimeout(400)
  const rowsNow = await linkRows(edit).count()
  check('4) 添加链接多出一行', rowsNow === 2, `rows=${rowsNow}`)
  await linkInput(edit, 1).fill('bad two')
  await page.waitForTimeout(900)
  const withTwo = (await edit.innerText()).replace(/\s+/g, ' ')
  check('4) 两条不合规时计数 2',
    withTwo.includes('2 条链接未通过校验'), withTwo.slice(0, 120))

  console.log('')
  console.log('=== 5. 保存：不合规也存下去（标记不是拦截） ===')
  await edit.getByRole('button', { name: '保存' }).first().click({ force: true })
  await page.waitForTimeout(2500)
  const stored = linksOf('linked')
  console.log(`  存下的链接: ${JSON.stringify(stored)}`)
  check('5) 不合规的两条都存进去了',
    stored.length === 2 && stored.includes('bad one') && stored.includes('bad two'),
    JSON.stringify(stored))
  check('5) 没有报错弹窗', await dialogWith('编辑项目').count() === 0,
    String(await dialogWith('编辑项目').count()))

  console.log('')
  console.log('=== 6. 重开对话框：读的是已存值，不是旧草稿 ===')
  const reopened = await openEditDialog('linked')
  const reopenedValues = []
  for (let i = 0; i < await linkRows(reopened).count(); i += 1) {
    reopenedValues.push(await linkInput(reopened, i).inputValue())
  }
  check('6) 两行都是已存值', reopenedValues.join('|') === 'bad one|bad two', reopenedValues.join('|'))

  console.log('')
  console.log('=== 7. 删掉一行并保存 → Host 收到更短的列表 ===')
  await linkRows(reopened).nth(1).getByRole('button').first().click({ force: true })
  await page.waitForTimeout(400)
  check('7) 删掉后只剩一行', await linkRows(reopened).count() === 1,
    `rows=${String(await linkRows(reopened).count())}`)
  await reopened.getByRole('button', { name: '保存' }).first().click({ force: true })
  await page.waitForTimeout(2500)
  check('7) Host 只存了一条', linksOf('linked').join('|') === 'bad one', linksOf('linked').join('|'))

  console.log('')
  console.log('=== 7c. 空行提示：跟随 0.5s 校验，与焦点无关 ===')
  // The rule the user settled on: a row counts while it is **empty**, whether or not it has
  // focus — but the notice follows the **check**, not the keystroke. Empty is one of the three
  // verdicts a check reaches, so it arrives with the other two instead of on a time line of its
  // own. That is what lets 删空 → 再输 replace the pending verdict, so the notice never shows.
  //
  // Two earlier rules are both superseded here. "Empty *and* unfocused" made the notice wait for
  // a blur, which said the row was dropped later than it became true. "Empty, live" reported it
  // the instant a key was pressed, which flashed it on the commonest path in the dialog.
  const notice = (dialog) => dialog.locator('[class*="linkBlankCount"]')
  const noticeDialog = await openEditDialog('linked')
  await noticeDialog.getByRole('button', { name: '添加链接' }).first().click({ force: true })
  await page.waitForTimeout(400)

  // An added row is **born blank**, which is a default rather than a verdict, so it neither
  // spins nor waits: it is counted at once, and the claim here is that it is counted **without**
  // a spinner — the thing the user objected to when a fresh row showed one.
  const justAdded = await notice(noticeDialog).count()
  check('7c) 刚添加的空行立刻计入提示（出生即空，无需判定）', justAdded === 1,
    `count=${String(justAdded)}`)
  check('7c) 刚添加的空行不转圈',
    await markOf(noticeDialog, 1) === 'none', await markOf(noticeDialog, 1))
  // The auto-focus still happens; it simply no longer decides the notice.
  check('7c) 新行仍自动聚焦',
    await linkInput(noticeDialog, 1).evaluate(node => node === document.activeElement),
    'activeElement')
  const addedText = (await noticeDialog.innerText()).replace(/\s+/g, ' ')
  check('7c) 提示文案是「1 行为空，保存时忽略」',
    addedText.includes('1 行为空，保存时忽略'), addedText.slice(0, 140))

  // Focusing it does NOT hide the notice — it is still an empty row.
  const newRowInput = linkInput(noticeDialog, 1)
  await newRowInput.click()
  await page.waitForTimeout(300)
  check('7c) 聚焦不会让提示消失（与焦点无关）',
    await notice(noticeDialog).count() === 1,
    `count=${String(await notice(noticeDialog).count())}`)

  // Typing a character starts a check. The blank notice is a **fact** about the live draft, so it
  // goes the moment the row stops being empty — it does **not** hold through the wait.
  //
  // This is the opposite of what this section asserted before 2026-10-09, and the reversal is the
  // point of the three-layer model: emptiness is not a verdict and must not wait for one. The
  // earlier expectation ("hold the notice so the header never flickers") came from a single-time-
  // line model in which the notice and the count had to move in step; they no longer share a clock.
  await newRowInput.type('h', { delay: 0 })
  await page.waitForTimeout(250)
  check('7c) 输入后空行提示立即消失（空是事实，不等判定）',
    await notice(noticeDialog).count() === 0,
    `count=${String(await notice(noticeDialog).count())}`)
  check('7c) 输入后行内在转圈',
    await markOf(noticeDialog, 1) === 'checking', await markOf(noticeDialog, 1))
  await page.waitForTimeout(700)
  check('7c) 落定后提示仍为无',
    await notice(noticeDialog).count() === 0,
    `count=${String(await notice(noticeDialog).count())}`)

  // ...and clearing it is immediate in the other direction: `''` is a fact too, so the notice is
  // back at once and the row shows **no** spinner. `''` reached by editing is no longer treated as
  // a verdict to wait for — the `edited` ref that drew that distinction is gone.
  await newRowInput.fill('')
  await page.waitForTimeout(250)
  check('7c) 清空后空行提示立即出现（不等 0.5s）',
    await notice(noticeDialog).count() === 1,
    `count=${String(await notice(noticeDialog).count())}`)
  check('7c) 清空后行内不转圈（空不是判定）',
    await markOf(noticeDialog, 1) !== 'checking', await markOf(noticeDialog, 1))
  await page.waitForTimeout(700)
  check('7c) 落定后提示回来',
    await notice(noticeDialog).count() === 1,
    `count=${String(await notice(noticeDialog).count())}`)

  // Whitespace is still empty: the same `trim()` rule the storing side uses.
  await newRowInput.fill('   ')
  await page.waitForTimeout(700)
  check('7c) 仅空白仍算空',
    await notice(noticeDialog).count() === 1,
    `count=${String(await notice(noticeDialog).count())}`)
  await newRowInput.fill('https://example.com/typed')
  await page.waitForTimeout(700)
  check('7c) 有内容后提示仍不出现',
    await notice(noticeDialog).count() === 0,
    `count=${String(await notice(noticeDialog).count())}`)

  // ## Does the live notice make the header jump?
  //
  // The notice appears and disappears as the user types, inside a one-line header that also
  // holds the add button. The concern is that its width changing would shift the header around
  // while typing. Measured rather than argued: a paper estimate of a layout question in this
  // file has already been wrong once (the add button's own position).
  //
  // The meaningful figure is the **header's** width and the button's x. The notice is inside
  // `.linkHeading`, which is the header's first child, so if it grows the button could in
  // principle be pushed — this asserts it is not.
  const stableHeaderBox = () => noticeDialog.locator('div[class*="linkHeader"]').first()
    .evaluate(node => ({ w: node.getBoundingClientRect().width, scroll: node.scrollWidth }))
  const buttonBox = () => noticeDialog.getByRole('button', { name: '添加链接' }).first()
    .evaluate(node => node.getBoundingClientRect().x)

  /** 反复在「空 → 有内容 → 空」之间切换，每次记录头行与按钮的位置。 */
  const geometry = []
  for (const value of ['', 'a', '', 'https://example.com/x', '', '   ', '']) {
    await newRowInput.fill(value)
    // Past `LINK_CHECK_DEBOUNCE_MS`, so every sample is a **settled** header: the question is
    // whether the geometry moves as the notices appear and disappear, not what it looks like
    // mid-check.
    await page.waitForTimeout(700)
    geometry.push({
      value: value === '' ? '(空)' : value,
      ...(await stableHeaderBox()),
      buttonX: await buttonBox(),
      notice: await notice(noticeDialog).count(),
    })
  }
  console.log(`  头行几何: ${JSON.stringify(geometry)}`)
  const widths = new Set(geometry.map(item => item.w))
  const buttonXs = new Set(geometry.map(item => item.buttonX))
  check('7c) 提示增删时头行宽度不变', widths.size === 1, JSON.stringify([...widths]))
  check('7c) 提示增删时添加链接位置不变', buttonXs.size === 1, JSON.stringify([...buttonXs]))
  check('7c) 头行始终不溢出',
    geometry.every(item => item.scroll <= item.w),
    JSON.stringify(geometry.map(item => ({ w: item.w, scroll: item.scroll }))))

  console.log('')
  console.log('=== 7d. 删行之后，其余空行的提示必须还在 ===')
  // The reported defect. The first implementation accumulated a set of "rows that have been
  // blurred" and cleared it whole on removal, on the theory that the next blur would redo it.
  // A blur only happens when focus moves: after a removal focus sits on the delete button,
  // nothing re-blurs, and the notice disappeared for every remaining blank row and never came
  // back (reported from a screenshot showing five empty rows and no notice).
  //
  // The count is derived now, so this cannot drift. Asserted through the numbers, because
  // "the notice exists" alone would pass while showing the wrong total.
  //
  // The 7c dialog is closed first: it is modal, so a new one cannot be opened and the row
  // behind it is not clickable.
  await noticeDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)
  const delDialog = await openEditDialog('linked')
  // Three rows added, alongside the one stored link. No blur and no wait are needed for the
  // count: an added row is **born blank**, which is a default rather than a verdict, so it is
  // counted the moment it exists.
  for (let i = 0; i < 3; i += 1) {
    await delDialog.getByRole('button', { name: '添加链接' }).first().click({ force: true })
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(500)
  const delText = (await delDialog.innerText()).replace(/\s+/g, ' ')
  check('7d) 三个空行时提示为 3', delText.includes('3 行为空，保存时忽略'), delText.slice(0, 150))

  // Delete the last blank row. Focus goes to the delete button, so nothing blurs afterwards —
  // exactly the situation the old model got wrong.
  //
  // Read **immediately**, well inside `LINK_CHECK_DEBOUNCE_MS`: a removal is the user's explicit
  // intent and the rows that remain already carry verdicts, so the header must follow the click
  // rather than hold its previous number for the interval. Asserting after a 500ms wait would
  // pass whether or not it waits, which is what the earlier version of this section did.
  await linkRows(delDialog).nth(3).getByRole('button').first().click({ force: true })
  // 120ms: long enough for React to commit and paint, far short of the 0.5s a wait would take.
  await page.waitForTimeout(120)
  const delImmediate = (await delDialog.innerText()).replace(/\s+/g, ' ')
  check('7d) 删除立即生效（不等 0.5s）',
    delImmediate.includes('2 行为空，保存时忽略') && !delImmediate.includes('3 行为空'),
    delImmediate.slice(0, 150))
  await page.waitForTimeout(500)
  const afterDel = (await delDialog.innerText()).replace(/\s+/g, ' ')
  check('7d) 删掉一行后提示仍在，且为 2',
    afterDel.includes('2 行为空，保存时忽略'), afterDel.slice(0, 150))

  // And again, to be sure it is not a one-off recalculation.
  await linkRows(delDialog).nth(2).getByRole('button').first().click({ force: true })
  await page.waitForTimeout(500)
  const afterTwoDels = (await delDialog.innerText()).replace(/\s+/g, ' ')
  check('7d) 再删一行后提示为 1',
    afterTwoDels.includes('1 行为空，保存时忽略'), afterTwoDels.slice(0, 150))

  // Filling the last blank row in leaves nothing to report.
  await linkInput(delDialog, 1).fill('https://example.com/filled')
  await page.waitForTimeout(600)
  const afterFill = (await delDialog.innerText()).replace(/\s+/g, ' ')
  check('7d) 把最后一个空行填上后提示消失',
    !afterFill.includes('行为空'), afterFill.slice(0, 150))
  // Closed before 7e opens its own: the dialog is modal, so the row behind it is unclickable.
  await delDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 7k. 删除一行不得牵连其他行（不重校验、不错配）===')
  // The reported defect: removing one row made every row after it re-check. The rows were keyed by
  // **index** while a check runs off the row's **value**, so a removal handed each later component
  // the next row's value — a value no user had touched. Two consequences, and the second is the
  // real one:
  //
  //   - each of those rows spun for 0.5s and reached the same verdict it already had;
  //   - for one frame it painted the verdict belonging to the value it **used to hold** onto the
  //     value it now holds. With a passing row above a failing one, the row read as *passing*
  //     while its text was `not a url` (measured: `["none","invalid"]` → `["none"]` for ~17ms).
  //     With four failing rows the frame is invisible, because a wrong verdict looks right.
  //
  // Rows now carry a stable id and are keyed by it, so a row moves without changing what it is.
  // The pair below (`https://ok…` above `not a url`) is what makes the mispairing observable.
  //
  // Recording per row and **frame by frame**: a snapshot after the fact cannot see either half.
  //
  // Each frame also carries the header's two notices, so "the three consumers moved in the same
  // pass" is measurable rather than inferred: two separate `evaluate` calls can straddle a commit
  // and would hide exactly the disagreement this file has been chasing.
  const installRowRecorder = (dialog) => dialog.evaluate((root) => {
    window.__rowStop?.()
    const frames = []
    let raf = 0
    let last = ''
    const textOf = (selector) => {
      const node = root.querySelector(selector)
      return node === null ? null : (node.textContent ?? '').trim()
    }
    const snap = () => {
      const marks = [...root.querySelectorAll('ul li')].map((li) => {
        const status = li.querySelector('span[class*="linkStatus"]')
        if (status === null) return 'none'
        if (status.querySelector('svg[data-state="ongoing"]') !== null) return 'checking'
        if (status.querySelector('[class*="linkInvalid"]') !== null) return 'invalid'
        if (status.querySelector('[class*="linkValid"]') !== null) return 'valid'
        return 'other'
      })
      const invalid = textOf('[class*="linkInvalidCount"]')
      const blank = textOf('[class*="linkBlankCount"]')
      const key = `${marks.join(',')}|${String(invalid)}|${String(blank)}`
      if (key === last) return
      last = key
      frames.push({ t: Math.round(performance.now()), marks, invalid, blank })
    }
    const loop = () => { snap(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    snap()
    window.__rowFrames = frames
    window.__rowStop = () => cancelAnimationFrame(raf)
  })
  const readRowFrames = (dialog) => dialog.evaluate(() => {
    window.__rowStop?.()
    const frames = window.__rowFrames ?? []
    if (frames.length === 0) return []
    const t0 = frames[0].t
    return frames.map(f => ({ ...f, t: f.t - t0 }))
  })
  /** 把一项目的链接重置并打开其对话框（此时行已全部落定）。 */
  const openSettled = async (links) => {
    // `storedProjects()` maps table **values**, so the id is the key — recovered here rather
    // than assumed to be a field on the record.
    const table = JSON.parse(readFileSync(`${dshHome}/storages/project_groups.json`, 'utf8')).tables?.projects ?? {}
    const projectId = Object.entries(table).find(([, record]) => record.title === 'linked')?.[0]
    const written = await rpc('projectGroups/update', {
      request: { projectId, title: 'linked', directories: [], links },
    })
    if (written.ok !== true) throw new Error(`7k 准备失败：update 未成功 — ${String(written.error)}`)
    await page.waitForTimeout(1400)
    const dialog = await openEditDialog('linked')
    await page.waitForTimeout(900)
    const rows = await linkRows(dialog).count()
    if (rows !== links.length) throw new Error(`7k 准备失败：期望 ${links.length} 行，实得 ${rows}`)
    await installRowRecorder(dialog)
    return dialog
  }
  /** 任一行是否出现过转圈。 */
  const anySpin = (frames) => frames.some(f => f.marks.includes('checking'))

  // 四种删除位置，共用一个断言：**没有任何一行**再进入 checking。
  for (const [label, at, links] of [
    ['删首行（4 条全部不合规）', 0, ['bad 1', 'bad 2', 'bad 3', 'bad 4']],
    ['删中间行（4 条全部不合规）', 1, ['bad 1', 'bad 2', 'bad 3', 'bad 4']],
    ['删末行（4 条全部不合规）', 3, ['bad 1', 'bad 2', 'bad 3', 'bad 4']],
    ['删首行（三行全合法）', 0, ['https://a.example', 'https://b.example', 'https://c.example']],
  ]) {
    const dialog = await openSettled(links)
    await linkRows(dialog).nth(at).getByRole('button').first().click({ force: true })
    await page.waitForTimeout(900)
    const frames = await readRowFrames(dialog)
    console.log(`  ${label}: ${JSON.stringify(frames)}`)
    check(`7k) ${label} 后没有任何行重新校验`, !anySpin(frames),
      JSON.stringify(frames))
    await dialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
  }

  // The mispairing itself, and the assertion is the **absence of `none`**: the surviving row's
  // text is `not a url`, so any frame showing it as anything but `invalid` is a verdict that
  // belongs to another row.
  {
    const dialog = await openSettled(['https://ok.example/x', 'not a url'])
    await linkRows(dialog).nth(0).getByRole('button').first().click({ force: true })
    await page.waitForTimeout(900)
    const frames = await readRowFrames(dialog)
    console.log(`  错配检查: ${JSON.stringify(frames)}`)
    check('7l) 删掉合法行后，剩下的不合规行不出现任何「合法」帧',
      frames.every(f => f.marks.length !== 1 || f.marks[0] === 'invalid'),
      JSON.stringify(frames))
    await dialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
  }

  // ...and the fix must not go too far: an **edit** still re-checks its own row, and adding a row
  // still leaves every existing row alone.
  {
    const dialog = await openSettled(['bad 1', 'bad 2', 'bad 3'])
    await installRowRecorder(dialog)
    await linkInput(dialog, 1).fill('bad 2 edited')
    await page.waitForTimeout(900)
    const frames = await readRowFrames(dialog)
    console.log(`  编辑行: ${JSON.stringify(frames)}`)
    check('7m) 编辑仍然只重校验被编辑的那一行',
      frames.some(f => f.marks.join(',') === 'invalid,checking,invalid'), JSON.stringify(frames))
    check('7m) 编辑不牵连其他行',
      frames.every(f => f.marks.filter(m => m === 'checking').length <= 1), JSON.stringify(frames))
    await dialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
  }
  {
    const dialog = await openSettled(['bad 1', 'bad 2'])
    await installRowRecorder(dialog)
    await dialog.getByRole('button', { name: '添加链接' }).first().click({ force: true })
    await page.waitForTimeout(900)
    const frames = await readRowFrames(dialog)
    console.log(`  新增行: ${JSON.stringify(frames)}`)
    check('7n) 新增一行不牵连已有行', !anySpin(frames), JSON.stringify(frames))
    await dialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
  }
  console.log('')
  console.log('=== 7o. 三层模型：清空/输入当拍，事实与判定不同时钟 ===')
  // The model this section pins (user's decision, 2026-10-09):
  //
  //   layer 1  emptiness  →  a **fact**,  applied the moment it is true (no wait)
  //   layer 2  a verdict  →  a **judgement**, waits for typing to stop (500ms, spinner)
  //   layer 3  correction →  automatic: a verdict only applies to the value it judged
  //
  // Everything here is about the **same pass**. The earlier model had one clock for all three, so
  // clearing a row left its ⓘ spinning half a second while the notice and the count moved on
  // their own schedules — the four defects of the previous rounds were all that single clock
  // showing up on a different consumer. Sampling the three together is therefore the whole
  // assertion: any of them alone can be right while another is stale.
  /** 三个消费者一起读：本行标记、未通过计数、空行提示。 */
  const layerSample = (dialog) => dialog.evaluate((root) => {
    const rows = [...root.querySelectorAll('ul li')]
    const markAt = (li) => {
      const status = li.querySelector('span[class*="linkStatus"]')
      if (status === null) return 'none'
      if (status.querySelector('svg[data-state="ongoing"]') !== null) return 'checking'
      if (status.querySelector('[class*="linkInvalid"]') !== null) return 'invalid'
      if (status.querySelector('[class*="linkValid"]') !== null) return 'valid'
      return 'other'
    }
    const textOf = (selector) => {
      const node = root.querySelector(selector)
      return node === null ? null : (node.textContent ?? '').trim()
    }
    return {
      marks: rows.map(markAt),
      invalid: textOf('[class*="linkInvalidCount"]'),
      blank: textOf('[class*="linkBlankCount"]'),
    }
  })

  {
    const dialog = await openSettled(['bad one', 'bad two'])
    await installRowRecorder(dialog)
    await page.waitForTimeout(900)
    const before = await layerSample(dialog)
    console.log(`  清空前: ${JSON.stringify(before)}`)
    check('7o) 清空前：两行不合规、计数 2、无空行提示',
      before.invalid === '2 条链接未通过校验' && before.blank === null,
      JSON.stringify(before))

    // Clear row 0. All three must move in the **same frame**: the row loses its ⓘ, the count
    // drops to 1, and the blank notice appears. No spinner anywhere in the clear path.
    await linkInput(dialog, 0).fill('')
    await page.waitForTimeout(200)
    const cleared = await layerSample(dialog)
    const clearedFrames = await readRowFrames(dialog)
    console.log(`  清空后 200ms: ${JSON.stringify(cleared)}`)
    console.log(`  清空逐帧: ${JSON.stringify(clearedFrames)}`)
    check('7o) 清空当拍：行内无标记',
      cleared.marks[0] === 'none', JSON.stringify(cleared.marks))
    check('7o) 清空当拍：计数立即为 1（不等 0.5s）',
      cleared.invalid === '1 条链接未通过校验', JSON.stringify(cleared.invalid))
    check('7o) 清空当拍：空行提示立即出现（不等 0.5s）',
      cleared.blank === '1 行为空，保存时忽略', JSON.stringify(cleared.blank))
    check('7o) 清空全程没有任何一行转圈',
      !anySpin(clearedFrames), JSON.stringify(clearedFrames))
    // The three consumers in **one** recorded frame: this is the assertion the layered model is
    // about. Every one of the previous rounds' defects was a frame in which one of these had
    // moved and another had not, and a single frame carrying all three settled values is exactly
    // what "different clocks" used to make impossible.
    const together = clearedFrames.find(f =>
      f.marks[0] === 'none'
      && f.invalid === '1 条链接未通过校验'
      && f.blank === '1 行为空，保存时忽略')
    check('7o) 清空：行内无标记 + 计数 1 + 空行提示，出现在同一帧',
      together !== undefined, JSON.stringify(clearedFrames))
    await dialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
  }

  // ...and the other direction: typing is a **judgement**, so it spins, and the row leaves the
  // count for the wait — it is not counted as failing on a value nothing has judged.
  {
    const dialog = await openSettled(['bad one', 'bad two'])
    await installRowRecorder(dialog)
    await page.waitForTimeout(900)
    const before = await layerSample(dialog)
    console.log(`  输入前: ${JSON.stringify(before)}`)
    await linkInput(dialog, 0).fill('bad one edited')
    await page.waitForTimeout(200)
    const typing = await layerSample(dialog)
    console.log(`  输入后 200ms（判定中）: ${JSON.stringify(typing)}`)
    check('7o) 输入当拍：该行转圈（判定层要等）',
      typing.marks[0] === 'checking', JSON.stringify(typing.marks))
    check('7o) 输入当拍：该行移出计数（未被判定的值不算数）',
      typing.invalid === '1 条链接未通过校验', JSON.stringify(typing.invalid))
    check('7o) 输入当拍：空行提示不出现（行是满的）',
      typing.blank === null, JSON.stringify(typing.blank))
    // After the wait the row re-enters the count on its actual result.
    await page.waitForTimeout(900)
    const landed = await layerSample(dialog)
    console.log(`  落定后: ${JSON.stringify(landed)}`)
    check('7o) 落定后：按结论归位（仍不合规 ⇒ 回到 2）',
      landed.invalid === '2 条链接未通过校验' && landed.marks[0] === 'invalid',
      JSON.stringify(landed))
    await dialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
  }

  // ...and the count must never describe a value that is gone: clearing an invalid row and
  // retyping keeps the count at 1 throughout, never 2 (the old value) and never 0.
  {
    const dialog = await openSettled(['bad one', 'bad two'])
    await page.waitForTimeout(900)
    await linkInput(dialog, 0).fill('')
    await page.waitForTimeout(150)
    const empty = await layerSample(dialog)
    check('7o) 清空后计数为 1，不残留旧值的 2',
      empty.invalid === '1 条链接未通过校验', JSON.stringify(empty.invalid))
    await linkInput(dialog, 0).fill('bad one retyped')
    await page.waitForTimeout(150)
    const retyped = await layerSample(dialog)
    check('7o) 重新输入后计数仍为 1（新值未判定，不冒充旧结论）',
      retyped.invalid === '1 条链接未通过校验', JSON.stringify(retyped.invalid))
    await page.waitForTimeout(900)
    const settledAgain = await layerSample(dialog)
    check('7o) 再落定后回到 2',
      settledAgain.invalid === '2 条链接未通过校验', JSON.stringify(settledAgain.invalid))
    // Closed before the next block opens its own dialog, as elsewhere in this file.
    await dialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
  }

  // This section drives the same project the earlier ones did, through four different link lists.
  // Put it back to the single known-invalid link those sections assume, or every one of them
  // starts from the wrong row count (measured: 11 failures downstream when this was missing).
  await setStoredLinks('linked', ['bad one'])

  console.log('')
  console.log('=== 7e. 计数只算「已判定的那个值」（编辑立即移出，落定后按结论归位）===')
  // The reported defect: the header counted the raw draft while each row debounced, so on the
  // first keystroke the header announced a number for a value nothing had judged yet — while the
  // row it described still spun.
  //
  // The rule now is a **pairing**, not a delay: a row is counted only while the url it holds is
  // the one that was judged. So the two halves of this section are:
  //
  //   - an edited row has **no verdict for its new value**, so it leaves the count at once — the
  //     header can neither report a failure the row has not reached, nor keep asserting the one it
  //     just replaced;
  //   - once the verdict lands, the row re-enters the count on its actual result.
  //
  // This replaces an earlier expectation that the header **hold** its previous number through the
  // wait. Holding was a treatment of the symptom: with the pairing there is no stale number to
  // hold, and a count of "2" during the wait would have been describing the value the user had
  // already replaced.
  const settleDialog = await openEditDialog('linked')
  // Two rows that are known-invalid, and let them settle so the count has a value to change from.
  await linkInput(settleDialog, 0).fill('bad one')
  await settleDialog.getByRole('button', { name: '添加链接' }).first().click({ force: true })
  await page.waitForTimeout(300)
  await linkInput(settleDialog, 1).fill('bad two')
  await settleDialog.getByLabel('项目名称').first().click()
  await page.waitForTimeout(1200)
  const settledText = (await settleDialog.innerText()).replace(/\s+/g, ' ')
  check('7e) 两行不合规时计数已稳定为 2',
    settledText.includes('2 条链接未通过校验'), settledText.slice(0, 150))

  /** 行内首行的标记 + 头行计数文本（`null` = 未显示）。 */
  const timingSample = () => settleDialog.evaluate((root) => {
    const status = root.querySelector('[class*="linkStatus"]')
    let mark = 'none'
    if (status !== null) {
      // `svg[data-state="ongoing"]` is the spinner specifically; the ⓘ and ✓ are svgs too.
      if (status.querySelector('svg[data-state="ongoing"]') !== null) mark = 'checking'
      else if (status.querySelector('[class*="linkInvalid"]') !== null) mark = 'invalid'
      else if (status.querySelector('[class*="linkValid"]') !== null) mark = 'valid'
    }
    const count = root.querySelector('[class*="linkInvalidCount"]')
    return { mark, count: count === null ? null : (count.textContent ?? '').trim() }
  })

  // Edit the first row into a valid url. It starts spinning, and it is **out of the count** for
  // the whole wait: 2 → 1, never "2" (which would describe the value just replaced) and never 0
  // (which would be counting a verdict that does not exist yet).
  await linkInput(settleDialog, 0).fill('https://example.com/now-valid')
  const spinning = []
  for (let i = 0; i < 4; i += 1) { spinning.push(await timingSample()); await page.waitForTimeout(110) }
  console.log(`  转圈期间采样: ${JSON.stringify(spinning)}`)
  check('7e) 行内在转圈', spinning.every(sample => sample.mark === 'checking'),
    JSON.stringify(spinning.map(sample => sample.mark)))
  check('7e) 编辑中的行立即移出计数（未被判定的值不算数）',
    spinning.every(sample => sample.count === '1 条链接未通过校验'),
    JSON.stringify(spinning.map(sample => sample.count)))

  // ...and once the row concludes, the header follows it immediately.
  await page.waitForTimeout(900)
  const afterSettle = (await settleDialog.innerText()).replace(/\s+/g, ' ')
  check('7e) 行内出结论后头行同步为 1',
    afterSettle.includes('1 条链接未通过校验') && !afterSettle.includes('2 条链接未通过校验'),
    afterSettle.slice(0, 150))
  await settleDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)

  await delDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 7f. 清空一行：行内与头行必须同时归零 ===')
  // The reported defect: clearing a row dropped its own ⓘ at once — `useLinkCheck` sends a
  // blank value straight to `idle`, because a blank has nothing to check — while the header
  // held the old number for another half second. The header waited on **every** draft change,
  // but the rows only wait on the changes that make them spin, so the two parted company on
  // exactly the blank transitions.
  //
  // Both halves are read in the **same sample**: asserting the mark alone, or the count alone,
  // would each pass while the other was still stale — which is how this shipped.
  //
  // The stored list is pinned to one known-invalid link first, so the starting count is a
  // literal rather than whatever the earlier sections happened to leave behind.
  await setStoredLinks('linked', ['bad one'])
  const clearDialog = await openEditDialog('linked')
  /** Row 0's mark plus the header count, read together in one pass. */
  const clearSample = () => clearDialog.evaluate((root) => {
    const status = root.querySelector('[class*="linkStatus"]')
    let mark = 'none'
    if (status !== null) {
      if (status.querySelector('svg[data-state="ongoing"]') !== null) mark = 'checking'
      else if (status.querySelector('[class*="linkInvalid"]') !== null) mark = 'invalid'
      else if (status.querySelector('[class*="linkValid"]') !== null) mark = 'valid'
    }
    const count = root.querySelector('[class*="linkInvalidCount"]')
    return { mark, count: count === null ? null : (count.textContent ?? '').trim() }
  })
  await linkInput(clearDialog, 0).click()
  await page.waitForTimeout(1200)
  const beforeClear = await clearSample()
  check('7f) 清空前计数已为 1（先有东西可清）',
    beforeClear.count === '1 条链接未通过校验' && beforeClear.mark === 'invalid',
    JSON.stringify(beforeClear))

  await linkInput(clearDialog, 0).fill('')
  const cleared = []
  // Sampled past `LINK_CHECK_DEBOUNCE_MS` (500ms) on purpose: the defect was a 0.5s lag, so a
  // window shorter than that could miss it entirely and pass on timing luck.
  for (let i = 0; i < 14; i += 1) { cleared.push(await clearSample()); await page.waitForTimeout(60) }
  console.log(`  清空后采样: ${JSON.stringify(cleared)}`)
  // A row the user **emptied** is empty, so it shows **no** spinner: emptiness is a fact, applied
  // on the spot, not a verdict to wait for. Asserted in the flipped direction on purpose — the
  // earlier design made an emptied row spin for half a second, and the assertion below used to
  // require exactly that. The `edited` ref that drew the born-blank/emptied distinction is gone;
  // both are now simply empty.
  check('7f) 清空后行内不转圈（空是事实，不是待判定的结论）',
    cleared.every(sample => sample.mark !== 'checking'),
    JSON.stringify(cleared.map(sample => sample.mark)))
  // The first sample can still read the pre-commit DOM: `fill` dispatches the event and React
  // re-renders on its own schedule, so a sample taken in the same tick sees the cleared input
  // with the old marks still mounted (measured while writing this). That is not the defect —
  // the defect is the two marks disagreeing **after** they have settled.
  //
  // So the claim is neither "every sample is empty" nor "the mark is gone", but the pairing:
  // in the sample where the row's own ⓘ has gone, the header must have gone with it. Asserting
  // either half alone is exactly how this shipped — each half was correct on its own.
  //
  // Only one link row exists here, so "the header has a number" and "this row is invalid" are
  // the same fact. With several rows they would not be, and this pairing would not be valid.
  const flipped = cleared.find(sample => sample.mark !== 'invalid' && sample.mark !== 'checking')
  check('7f) 清空后行内 ⓘ 确实消失', flipped !== undefined,
    JSON.stringify(cleared.map(sample => sample.mark)))
  check('7f) 行内消失的那一拍，头行计数也同时为 null（不滞后）',
    flipped !== undefined && flipped.count === null, JSON.stringify(flipped))
  // ...and nothing later puts the header back on its own.
  check('7f) 之后头行不再单独持有计数',
    cleared.slice(cleared.indexOf(flipped)).every(sample => sample.count === null),
    JSON.stringify(cleared.map(sample => sample.count)))
  await clearDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 7g. 清空时两个提示必须同一拍（不许有一帧并列）===')
  // The reported defect: clearing an invalid row showed `1 条链接未通过校验` and
  // `1 行为空，保存时忽略` **in the same frame** — one line, two segments, one flash — before
  // the first dropped on the next render. The blank notice is derived during render; the count
  // came back from state, which arrives a render later, so the two were painted from different
  // passes.
  //
  // Sampled from **inside the page** with `requestAnimationFrame`, not by polling with
  // `evaluate`: the bad frame exists for one commit, and a round trip between samples can miss
  // it entirely (that is how 7f's own first version measured the wrong thing).
  //
  // The single-row case is what makes the assertion clean: one invalid row, cleared, so the
  // **only** correct end state is "no count, blank notice". Any frame holding both is the
  // defect — no need to know which number is stale.
  const orderDialog = await openEditDialog('linked')
  await linkInput(orderDialog, 0).click()
  await page.waitForTimeout(1200)
  await orderDialog.evaluate((root) => {
    const header = root.querySelector('[class*="linkHeader"]')
    const frames = []
    let raf = 0
    const snap = () => {
      const inv = header.querySelector('[class*="linkInvalidCount"]')
      const blk = header.querySelector('[class*="linkBlankCount"]')
      frames.push({ inv: inv === null ? null : inv.textContent.trim(),
        blk: blk === null ? null : blk.textContent.trim() })
    }
    const loop = () => { snap(); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    snap()
    window.__orderFrames = frames
    window.__orderStop = () => cancelAnimationFrame(raf)
  })
  await linkInput(orderDialog, 0).fill('')
  await page.waitForTimeout(900)
  const orderFrames = await orderDialog.evaluate(() => {
    window.__orderStop?.()
    return window.__orderFrames ?? []
  })
  // Only frames after the clear are interesting, but a frame recorder cannot be reset from the
  // outside at the right moment — instead, drop the leading run that still shows the count with
  // no blank notice, which is the untouched starting state.
  const start = orderFrames.findIndex(f => f.blk !== null)
  const afterClear = start === -1 ? [] : orderFrames.slice(start)
  console.log(`  清空后逐帧（自空行提示出现起，共 ${afterClear.length} 帧）: ${JSON.stringify(afterClear)}`)
  check('7g) 清空后确实进入了「空行提示在场」的状态', afterClear.length > 0,
    JSON.stringify(orderFrames.slice(-6)))
  check('7g) 没有任何一帧同时显示未通过计数与空行提示',
    afterClear.every(f => !(f.inv !== null && f.blk !== null)),
    JSON.stringify(afterClear.filter(f => f.inv !== null && f.blk !== null)))
  check('7g) 稳定后计数已消失、空行提示在场',
    afterClear.length > 0 && afterClear[afterClear.length - 1].inv === null
    && afterClear[afterClear.length - 1].blk !== null,
    JSON.stringify(afterClear[afterClear.length - 1]))
  await orderDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 7h. 打开对话框：行内与头行一起校验、一起出 ===')
  // ③: opening a project dialog checks every row once, and the header waits with them rather
  // than showing a count no row has reached yet. An earlier version had the header seeded from
  // the draft, so it announced the verdict while the rows beside it still spun — the first
  // defect in this file, in its original form.
  //
  // The stored list is known-invalid, so a count that appears early is unambiguously the header
  // leading the rows rather than reporting something already true.
  await setStoredLinks('linked', ['bad one'])
  const { dialog: openDialog, frames: openFrames } = await openEditDialogRecorded('linked')
  console.log(`  打开过程逐帧: ${JSON.stringify(openFrames.slice(0, 8))}`)
  // The first frame that shows the header's notice at all, and the first that shows a verdict,
  // must both come **after** the row has been seen checking — otherwise the header led the rows.
  const firstMarked = openFrames.findIndex(f => f.mark !== 'none')
  const firstCount = openFrames.findIndex(f => f.count !== null)
  check('7h) 打开时行内先进入校验', firstMarked !== -1 && openFrames[firstMarked].mark === 'checking',
    JSON.stringify(openFrames.slice(0, 5)))
  check('7h) 头行不抢先报数（先有转圈，后有计数）',
    firstCount === -1 || (firstMarked !== -1 && firstCount >= firstMarked),
    `firstMarked=${String(firstMarked)} firstCount=${String(firstCount)} ${JSON.stringify(openFrames.slice(0, 5))}`)
  await page.waitForTimeout(900)
  const afterOpen = (await openDialog.innerText()).replace(/\s+/g, ' ')
  check('7h) 落定后头行报数', afterOpen.includes('1 条链接未通过校验'), afterOpen.slice(0, 150))
  // 7j, in the same dialog: focusing a row whose verdict has landed must not restart the check.
  await linkInput(openDialog, 0).click()
  const focused = await openDialog.evaluate((root) => {
    const status = root.querySelector('ul li span[class*="linkStatus"]')
    return status !== null && status.querySelector('svg[data-state="ongoing"]') !== null
  })
  check('7j) 聚焦已判定的行不重新校验（不出转圈）', focused === false, String(focused))
  const stillInvalid = await openDialog.evaluate((root) => {
    const status = root.querySelector('ul li span[class*="linkStatus"]')
    return status !== null && status.querySelector('[class*="linkInvalid"]') !== null
  })
  check('7j) 聚焦后标记保持为橙 ⓘ', stillInvalid === true, String(stillInvalid))
  await openDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 7i. 头行的记忆不得跨对话框（换项目时不许复用旧计数）===')
  // The reported defect. The settled-count hook used to live at the **dialog** component's top
  // level, where it survives the dialog closing, while the rows unmount with the dialog. Opening
  // another project therefore showed the previous project's number for the whole wait — one
  // project's count painted on another project's dialog.
  //
  // Asserted as a **negative**, and recorded from **before** the dialog opens: the leak only
  // lasts as long as the wait does (500ms), and `openEditDialog` waits 900ms before returning, so
  // a recorder installed afterwards cannot see it at all. That is the same sampling mistake 7h
  // was written with first — and it is why this section reads frames rather than a snapshot.
  await rpc('projectGroups/create', { request: { title: 'clean', links: ['https://example.com/ok'] } })
  await page.waitForTimeout(2000)
  // `linked` currently holds one invalid link; `clean` holds a passing one. A number showing up
  // while `clean` is open can only have come from `linked`.
  const { dialog: leakDialog, frames: leakFrames } = await openEditDialogRecorded('clean')
  const leaked = leakFrames.filter(frame => frame.count !== null)
  console.log(`  打开 clean 期间的帧: ${JSON.stringify(leakFrames.slice(0, 6))}`)
  check('7i) 打开全合法的项目时头行从不显示旧计数',
    leaked.length === 0, JSON.stringify(leaked.slice(0, 3)))
  check('7i) 打开 clean 时确实完成了校验（拿到过标记，说明记录器有效）',
    leakFrames.some(frame => frame.mark !== 'none'),
    JSON.stringify(leakFrames.slice(0, 6)))
  await leakDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)

  const colorDialog = await openEditDialog('linked')
  await colorDialog.getByRole('button', { name: '添加链接' }).first().click({ force: true })
  await page.waitForTimeout(400)
  const colorInput = linkInput(colorDialog, 1)
  const colorOf = async (selector) =>
    await colorDialog.locator(selector).first().evaluate(node => getComputedStyle(node).color)
  await colorInput.fill('not a url')
  await page.waitForTimeout(400)
  // Add a second row and leave it empty: one invalid row plus one blank row, so both notices
  // are on screen together. No blur needed — an empty row counts on its own now.
  await colorDialog.getByRole('button', { name: '添加链接' }).first().click({ force: true })
  await page.waitForTimeout(400)
  const invalidColor = await colorOf('[class*="linkInvalidCount"]')
  const blankColor = await colorOf('[class*="linkBlankCount"]')
  console.log(`  琥珀计数=${invalidColor}  空行提示=${blankColor}`)
  check('7c) 两种提示同时出现', await notice(colorDialog).count() === 1
    && await colorDialog.locator('[class*="linkInvalidCount"]').count() === 1,
  `blank=${String(await notice(colorDialog).count())} invalid=${String(await colorDialog.locator('[class*="linkInvalidCount"]').count())}`)
  check('7c) 空行提示是弱化色，与琥珀不同', blankColor !== invalidColor,
    `${blankColor} vs ${invalidColor}`)

  // ...and it must be READABLE, in **both** themes.
  //
  // The first colour shipped was `label-dimmed` — the token the official styles reserve for
  // `:disabled` and `::placeholder`. It measured 1.45 against the dark dialog surface: the
  // notice was there and effectively invisible, which is how the user found it. A
  // "different from amber" assertion passes happily on an invisible colour, so this one
  // measures contrast against the surface the text actually sits on.
  const contrastOf = async (selector) => await colorDialog.locator(selector).first()
    .evaluate((node) => {
      /** WCAG relative luminance of an `rgb(r, g, b)` string. */
      const lum = (rgb) => {
        const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
          const c = v / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      // Walk up to the first opaque background: that is what the text is painted on, and it
      // is the dialog's own colour rather than the body's.
      let surface = 'rgb(255, 255, 255)'
      let current = node
      while (current !== null) {
        const bg = getComputedStyle(current).backgroundColor
        const alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3]) : 1
        if (alpha > 0.9) { surface = bg; break }
        current = current.parentElement
      }
      const [a, b] = [lum(getComputedStyle(node).color), lum(surface)].sort((m, n) => n - m)
      return Number(((a + 0.05) / (b + 0.05)).toFixed(2))
    })
  const blankLight = await contrastOf('[class*="linkBlankCount"]')
  console.log(`  空行提示对比度（浅色）= ${blankLight}`)
  check('7c) 空行提示在浅色主题下可读（≥3）', blankLight >= 3, String(blankLight))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(1200)
  const blankDark = await contrastOf('[class*="linkBlankCount"]')
  console.log(`  空行提示对比度（深色）= ${blankDark}`)
  check('7c) 空行提示在深色主题下可读（≥3）', blankDark >= 3, String(blankDark))
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(800)
  // And the header must not overflow with both notices on screen — the one thing that can
  // only be settled by measuring (a paper estimate of this got the earlier layout bug wrong).
  const overflow = await colorDialog.locator('div[class*="linkHeader"]').first().evaluate(node =>
    ({ scroll: node.scrollWidth, client: node.clientWidth }))
  check('7c) 两个提示同时在场时头行不溢出', overflow.scroll <= overflow.client,
    JSON.stringify(overflow))
  await colorDialog.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)

  console.log('')
  console.log('=== 7b. 空行不落库（ghost row 的根因）===')
  // The reported defect, end to end: add a row, type nothing, and change something else so
  // the save is enabled. The blank row must not become a link.
  //
  // Without the fix the row was stored as `["bad one",""]`, which produced three symptoms at
  // once — a bare `- ` in the injected block, a ghost row on the next open, and a 保存 that
  // looked stuck because that ghost row read as "unchanged".
  const blankDialog = await openEditDialog('linked')
  await blankDialog.getByRole('button', { name: '添加链接' }).first().click({ force: true })
  await page.waitForTimeout(400)
  check('7b) 空行已渲染出来', await linkRows(blankDialog).count() === 2,
    `rows=${String(await linkRows(blankDialog).count())}`)
  // Touch the **title** so `renameBlocked` is false for a reason that is not the blank row.
  // Selected by its own label: `input[type="text"]` matches the link rows too, and taking
  // the first one edits a link instead of the title (measured, while writing this probe).
  const titleInput = blankDialog.getByLabel('项目名称').first()
  check('7b) 标题输入框存在', await titleInput.count() === 1,
    `count=${String(await titleInput.count())}`)
  await titleInput.fill('linked renamed')
  await page.waitForTimeout(400)
  await blankDialog.getByRole('button', { name: '保存' }).first().click({ force: true })
  await page.waitForTimeout(2500)
  console.log(`  存下的链接: ${JSON.stringify(linksOf('linked renamed'))}`)
  check('7b) 空行没有被存进去',
    linksOf('linked renamed').join('|') === 'bad one', linksOf('linked renamed').join('|'))
  // And the ghost row is gone: reopening shows only the real link.
  const afterBlank = await openEditDialog('linked renamed')
  check('7b) 重开后没有幽灵空行', await linkRows(afterBlank).count() === 1,
    `rows=${String(await linkRows(afterBlank).count())}`)
  await afterBlank.getByRole('button', { name: '取消' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(600)
  // Restore the title so the later sections keep addressing the same row name.
  await rpc('projectGroups/update', {
    request: { projectId: projectIdOf('linked renamed'), title: 'linked', directories: [], links: ['bad one'] },
  })
  await page.waitForTimeout(1500)

  console.log('')
  console.log('=== 8. 关掉开关 → 标记整套消失 ===')
  await rpc('projectGroups/setValidateLinks', { request: { value: false } })
  await page.waitForTimeout(1500)
  check('8) 开关已存为 false', validateLinksSetting() === false, String(validateLinksSetting()))
  const offDialog = await openEditDialog('linked')
  check('8) 关掉后仍渲染链接行', await linkRows(offDialog).count() === 1,
    `rows=${String(await linkRows(offDialog).count())}`)
  await linkInput(offDialog, 0).click()
  await linkInput(offDialog, 0).fill('still not a url')
  await page.waitForTimeout(1300)
  const offMark = await markOf(offDialog, 0)
  check('8) 关掉后不出标记', offMark === 'none', offMark)
  const offText = (await offDialog.innerText()).replace(/\s+/g, ' ')
  check('8) 关掉后没有计数', !offText.includes('未通过校验'), offText.slice(0, 120))

  // The blank-row notice is NOT part of what the switch governs: blanks are dropped on save
  // whether or not links are being marked, so hiding this notice with the switch would hide
  // something still true. The switch governs validation, and validation only.
  await linkInput(offDialog, 0).fill('')
  await offDialog.getByLabel('项目名称').first().click()
  await page.waitForTimeout(500)
  check('8) 关掉校验后空行提示仍在',
    await offDialog.locator('[class*="linkBlankCount"]').count() === 1,
    `count=${String(await offDialog.locator('[class*="linkBlankCount"]').count())}`)

  console.log('')
  console.log('=== 9. 页面无 console 错误 ===')
  const realErrors = consoleErrors.filter(text => !text.includes('favicon'))
  check('9) 无 React 嵌套警告 / 页面错误', realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} catch (error) {
  driverError = error
  console.log(`\nDRIVER ERROR: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
process.exit(driverError !== undefined || failures.length > 0 ? 1 : 0)
