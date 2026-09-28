/**
 * The motion a Session row makes when it changes group — measured per frame.
 *
 * This is the acceptance probe for `sessionRowKey`. It exists because the earlier
 * probes on this path were misleading: they hooked `Element.prototype.animate` and
 * reported "moved" whenever a transform animation was *created*, which is also what
 * happens to a row that snaps. A dense position sampler settled it — a cross-group
 * drag has exactly two positions and nothing between — so the same method is used
 * here.
 *
 * What is measured, and why each is the right signal:
 *
 *   - **the row key per frame**, so "the same Session under a new group" is visible
 *     as a key change while the Session id stays put;
 *   - **the row's y per frame, without deduplication**, so travel shows as a run of
 *     intermediate positions and a fade-and-replace shows one jump;
 *   - **which animations ran**, read from the keyframes, because a fade is
 *     `opacity→opacity` and a glide is `transform+opacity→transform+opacity`.
 *
 * The four transitions the design turns on:
 *
 *   1. A project's ＋ with no blank yet       → the row appears (entry fade)
 *   2. The same project's ＋ again            → nothing at all
 *   3. a different project's ＋               → the old row leaves and a new row
 *      arrives, and the Session does **not** travel between them
 *   4. the blank becoming real (first prompt) → no animation, patched in place,
 *      matching the official sidebar
 *
 * Usage: node probe-row-key-motion.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { installRowKeyHelpers } from './lib/row-key.mjs'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-row-key-motion.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17760 : 17761
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
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${out.slice(-1500)}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
// Installed before every navigation, so the in-page parser survives a reload.
await installRowKeyHelpers(page)

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

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()

const makeProject = async (title) => {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

/** Every rendered Session row: id, group, row key, and y. */
const sessionRows = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-row-key]')]
  let group = null
  const found = []
  for (const node of rows) {
    const key = node.getAttribute('data-row-key')
    if (key.startsWith('workspace:')) {
      const id = key.slice('workspace:'.length)
      group = id === '' ? 'ungrouped' : id
      continue
    }
    // The injected parser is the one place a row key is split; see lib/row-key.mjs.
    const id = window.__sessionIdOf(key)
    if (id === null) continue
    found.push({
      id,
      ownGroup: window.__groupIdOf(key),
      group,
      key,
      y: Math.round(node.getBoundingClientRect().top),
      blank: (node.textContent ?? '').includes('新会话'),
    })
  }
  return found
})

/**
 * Sample every Session row each animation frame, keeping every sample.
 *
 * No deduplication, and whole-list rather than one id: the row under test is
 * re-parented into another group's DOM subtree mid-window, so a held element
 * reference would go stale exactly when the interesting change happens.
 */
const startSampler = (windowMs) => page.evaluate((windowMs) => {
  const samples = []
  const animations = []
  const start = performance.now()
  const sample = () => {
    const rows = [...document.querySelectorAll('[data-row-key]')]
    let group = null
    const seen = []
    for (const node of rows) {
      const key = node.getAttribute('data-row-key')
      if (key.startsWith('workspace:')) {
        const id = key.slice('workspace:'.length)
        group = id === '' ? 'ungrouped' : id
        continue
      }
      const id = window.__sessionIdOf(key)
      if (id === null) continue
      seen.push({
        id,
        ownGroup: window.__groupIdOf(key),
        group,
        key,
        y: Math.round(node.getBoundingClientRect().top),
        blank: (node.textContent ?? '').includes('新会话'),
      })
    }
    samples.push({ t: Math.round(performance.now() - start), rows: seen })
    if (performance.now() - start < windowMs) window.__samplerRaf = requestAnimationFrame(sample)
  }
  const original = Element.prototype.animate
  Element.prototype.animate = function (keyframes, options) {
    const key = this.getAttribute?.('data-row-key') ?? ''
    const id = window.__sessionIdOf(key)
    if (id !== null) {
      animations.push({
        id,
        ownGroup: window.__groupIdOf(key),
        frames: Array.isArray(keyframes)
          ? keyframes.map(frame => Object.keys(frame).filter(k => k !== 'offset').join('+')).join('→')
          : 'obj',
        duration: typeof options === 'object' ? options?.duration : options,
      })
    }
    return original.call(this, keyframes, options)
  }
  sample()
  window.__sampler = { samples, animations, restore: () => { Element.prototype.animate = original } }
}, windowMs)

const readSampler = () => page.evaluate(() => {
  cancelAnimationFrame(window.__samplerRaf)
  window.__sampler.restore()
  return window.__sampler
})

const armList = () => page.evaluate(() => {
  document.querySelector('[role="tree"]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
})

const clickPlus = async (title) => {
  const row = projectRow(title)
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await row.locator('button[aria-label^="在"]').first().click({ force: true })
}

/** The distinct Session ids rendered at any point in the window. */
const idsIn = (samples) => [...new Set(samples.flatMap(sample => sample.rows.map(row => row.id)))]

/** The y sequence for one Session id across the window. */
const trajectory = (samples, id) => samples
  .map(sample => sample.rows.find(row => row.id === id))
  .filter(row => row !== undefined)
  .map(row => row.y)

/** Group keys one Session id was seen under. */
const groupsOf = (samples, id) => [...new Set(samples
  .flatMap(sample => sample.rows.filter(row => row.id === id).map(row => row.group))
  .filter(group => group !== null))]

/**
 * Classify one window: did the row travel, or was it replaced?
 *
 * `travels` requires a run of intermediate positions — the dense sampler's whole
 * point. `hasTransform` is reported alongside because a row can carry a transform
 * animation and still be replaced at the same coordinates, which is the false
 * positive this probe was written to avoid.
 */
const classify = (label, samples, animations, id) => {
  const ys = [...new Set(trajectory(samples, id))]
  const relevant = animations.filter(animation => animation.id === id)
  const hasTransform = relevant.some(animation => animation.frames.includes('transform'))
  const hasOpacity = relevant.some(animation => animation.frames.includes('opacity'))
  const groups = groupsOf(samples, id)
  console.log(`\n--- ${label}`)
  console.log(`    id=${String(id).slice(-10)}  组=${JSON.stringify(groups)}`)
  console.log(`    y 不同值 ${ys.length} 个: ${JSON.stringify(ys)}`)
  console.log(`    动画: ${relevant.length === 0 ? '(无)' : JSON.stringify(relevant.map(a => `${a.frames}/${String(a.duration)}ms`))}`)
  return { ys, hasTransform, hasOpacity, animations: relevant, groups }
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  const stamp = Date.now().toString(36)
  const A = `甲${stamp}`
  const B = `乙${stamp}`
  await makeProject(A)
  await makeProject(B)
  const groupKeyOf = async (title) => {
    const key = await projectRow(title).getAttribute('data-row-key')
    return (key ?? '').replace('workspace:', '')
  }
  const keyA = await groupKeyOf(A)
  const keyB = await groupKeyOf(B)
  console.log(`项目: ${A}=${keyA}  ${B}=${keyB}`)

  await armList()
  const WINDOW = 1600

  // ── 1. A's ＋ with no blank yet: the row should appear. ──
  console.log(`\n=== 1) 点 ${A} 的 ＋（尚无空白）===`)
  const s1 = startSampler(WINDOW)
  await page.waitForTimeout(150)
  await clickPlus(A)
  await s1
  await page.waitForTimeout(1400)
  const r1 = await readSampler()
  const blankId1 = r1.samples.flatMap(sample => sample.rows.find(row => row.blank)?.id ?? []).at(-1) ?? null
  const c1 = classify(`点 ${A} 的 ＋`, r1.samples, r1.animations, blankId1)
  const rowsAfter1 = await sessionRows()
  check('1) ＋ 之后出现了一个空白会话', blankId1 !== null, String(blankId1))
  check('1) 该空白属于该项目', rowsAfter1.find(row => row.id === blankId1)?.group === keyA,
    `组=${String(rowsAfter1.find(row => row.id === blankId1)?.group)}`)
  check('1) 行 key 带上了所属项目', rowsAfter1.find(row => row.id === blankId1)?.key === `session:${blankId1}@${keyA}`,
    String(rowsAfter1.find(row => row.id === blankId1)?.key))
  check('1) 新行播放了入场动画', c1.animations.length > 0, JSON.stringify(c1.animations.map(a => a.frames)))
  await dismiss()

  // ── 2. The same project's ＋ again: nothing should happen. ──
  console.log(`\n=== 2) 再点 ${A} 的 ＋（同一空白应无行为）===`)
  const s2 = startSampler(WINDOW)
  await page.waitForTimeout(150)
  await clickPlus(A)
  await s2
  await page.waitForTimeout(1400)
  const r2 = await readSampler()
  const rowsAfter2 = await sessionRows()
  const blankId2 = rowsAfter2.find(row => row.blank)?.id ?? null
  console.log(`\n--- 2) 采样`)
  console.log(`    空白会话: ${String(blankId1).slice(-10)} → ${String(blankId2).slice(-10)}`)
  console.log(`    采样中该会话的 y 不同值: ${JSON.stringify([...new Set(trajectory(r2.samples, blankId2))].length)}`)
  console.log(`    动画: ${JSON.stringify(r2.animations.map(a => `${a.frames}`))}`)
  check('2) 仍是同一个空白会话', blankId1 !== null && blankId1 === blankId2)
  check('2) 没有换组', rowsAfter2.find(row => row.id === blankId2)?.group === keyA)
  check('2) 没有对该会话做任何动画', r2.animations.filter(a => a.id === blankId2).length === 0,
    JSON.stringify(r2.animations.filter(a => a.id === blankId2)))
  await dismiss()

  // ── 3. The other project's ＋: the crux. The Session must not travel. ──
  console.log(`\n=== 3) 点 ${B} 的 ＋（关键：不得平移）===`)
  const s3 = startSampler(WINDOW)
  await page.waitForTimeout(150)
  await clickPlus(B)
  await s3
  await page.waitForTimeout(1400)
  const r3 = await readSampler()
  const rowsAfter3 = await sessionRows()
  const blankAfter3 = rowsAfter3.find(row => row.blank) ?? null
  const travelledId = blankAfter3?.id ?? blankId2
  const c3 = classify(`点 ${B} 的 ＋`, r3.samples, r3.animations, travelledId)

  console.log(`\n  采样窗口内出现过的会话: ${JSON.stringify(idsIn(r3.samples).map(id => String(id).slice(-10)))}`)
  for (const id of idsIn(r3.samples)) {
    const groups = groupsOf(r3.samples, id)
    const ys = [...new Set(trajectory(r3.samples, id))]
    console.log(`    ${String(id).slice(-10)}: 组=${JSON.stringify(groups)} y不同值=${ys.length} ${JSON.stringify(ys)}`)
  }
  const ids3 = idsIn(r3.samples)
  const travelled = ids3.some(id => groupsOf(r3.samples, id).length > 1 && [...new Set(trajectory(r3.samples, id))].length >= 4)
  console.log(`  是否出现了"同一会话横跨两组且 y 有中间位置": ${travelled}`)

  check('3) 空白会话现在属于新项目', blankAfter3?.group === keyB, `组=${String(blankAfter3?.group)}`)
  check('3) 行 key 带上了新项目', blankAfter3?.key === `session:${blankAfter3?.id}@${keyB}`, String(blankAfter3?.key))
  check('3) 换组【不是】平移（无中间位置）', !travelled)
  const c3Blank = c3.animations.filter(a => a.id === travelledId)
  check('3) 换组伴随动画（淡出/淡入）', c3Blank.length > 0, JSON.stringify(c3Blank.map(a => a.frames)))
  check('3) 该会话的动画里【没有】transform', !c3Blank.some(a => a.frames.includes('transform')),
    JSON.stringify(c3Blank.map(a => a.frames)))
  await dismiss()

  // ── 4. The blank becoming real: official patches in place, with no animation. ──
  console.log(`\n=== 4) 发送第一条消息，让空白变成真会话（应与官方一致：零动画）===`)
  const beforeReal = (await sessionRows()).find(row => row.blank) ?? null
  console.log(`    目标会话: ${String(beforeReal?.id).slice(-10)}  组=${String(beforeReal?.group)}  key=${String(beforeReal?.key)}`)
  const s4 = startSampler(2600)
  await page.waitForTimeout(150)
  const composer = page.locator('[contenteditable="true"], textarea').first()
  await composer.click({ force: true })
  await composer.type('1', { delay: 40 })
  await page.keyboard.press('Enter')
  await s4
  await page.waitForTimeout(2000)
  const r4 = await readSampler()
  const c4 = classify(`空白→真会话`, r4.samples, r4.animations, beforeReal?.id)
  const afterReal = (await sessionRows()).find(row => row.id === beforeReal?.id) ?? null
  check('4) 会话仍是同一个（id 未变）', afterReal !== null)
  check('4) 它没有换组', afterReal?.group === beforeReal?.group, `${String(beforeReal?.group)} → ${String(afterReal?.group)}`)
  check('4) 行 key 未变（因此原地更新）', afterReal?.key === beforeReal?.key, `${String(beforeReal?.key)} → ${String(afterReal?.key)}`)
  check('4) 没有任何动画（与官方一致）', c4.animations.length === 0, JSON.stringify(c4.animations.map(a => a.frames)))
  const y4 = [...new Set(trajectory(r4.samples, beforeReal?.id))]
  check('4) 位置未变（无位移补间）', y4.length === 1, JSON.stringify(y4))

  // ── 5. Regression: a cross-group drag must still snap. ──
  // A real Session is seeded in the *other* project first, so the drag has both a
  // source and a target row; without one the check silently skips, and a skipped
  // regression guard is not a guard.
  console.log(`\n=== 5) 回归：跨组拖拽应仍是瞬移 ===`)
  const seedPlus = async (title, message) => {
    const before = new Set((await sessionRows()).map(row => row.id))
    await dismiss()
    await clickPlus(title)
    await page.waitForTimeout(4000)
    await dismiss()
    const fresh = (await sessionRows()).find(row => !before.has(row.id) && row.blank)
      ?? (await sessionRows()).find(row => !before.has(row.id))
    if (fresh === undefined) return null
    const composer = page.locator('[contenteditable="true"], textarea').first()
    await composer.click({ force: true })
    await composer.type(message, { delay: 40 })
    await page.keyboard.press('Enter')
    for (let poll = 0; poll < 20; poll += 1) {
      await page.waitForTimeout(1000)
      const row = (await sessionRows()).find(candidate => candidate.id === fresh.id)
      if (row !== undefined && !row.blank) return row
    }
    return null
  }
  const source = await seedPlus(A, 'a-drag')
  console.log(`    在 ${A} 里种了一个真实会话: ${String(source?.id).slice(-10)}  key=${String(source?.key)}`)
  const target = source === null
    ? null
    : (await sessionRows()).find(row => row.group !== source.group) ?? null
  if (source === null || target === null) {
    console.log('    跳过：没能造出可拖拽的源/目标')
  } else {
    const s5 = startSampler(WINDOW)
    await page.waitForTimeout(150)
    await page.locator(`[data-row-key="${source.key}"]`).first()
      .dragTo(page.locator(`[data-row-key="${target.key}"]`).first(), { timeout: 20_000 })
    await s5
    await page.waitForTimeout(1400)
    const r5 = await readSampler()
    const c5 = classify(`拖 ${source.key} → ${target.key}`, r5.samples, r5.animations, source.id)
    check('5) 拖拽后仍是瞬移（无中间位置）', c5.ys.length <= 2, JSON.stringify(c5.ys))
    const landed = (await sessionRows()).find(row => row.id === source.id)
    check('5) 会话确实换到了另一个组', landed !== null && landed.group !== source.group,
      `${String(source.group)} → ${String(landed?.group)}`)
  }

  console.log(`\n=== 结果 ===`)
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
