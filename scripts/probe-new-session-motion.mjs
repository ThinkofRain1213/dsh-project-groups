/**
 * Fade or move: does a project row's New Session animate like the official one?
 *
 * The reported defect, and its three-way shape:
 *
 *   1. ＋ on project A files the blank Session under A.
 *   2. Selecting an existing Session collapses the blank (a blank renders only
 *      while it is the current one), so it is in no commit at all.
 *   3. ＋ on A again behaves like the official sidebar — it FADES IN.
 *      ＋ on B instead shows the row under A and then GLIDES it into B.
 *
 * Steps 2 and the difference between the two halves of 3 are the whole test. The
 * blank Session carries whatever assignment it had, so a placement that waits for
 * the Host renders that previous owner for one frame; `AnimatedRows` then sees a
 * known key at a new position and glides it, where a key fresh to the commit
 * fades. The animation that runs therefore *names* the cause.
 *
 * ## Why this drives real clicks and real input
 *
 * `AnimatedRows` only starts animating after the first pointer or keyboard input
 * inside the list (`onPointerDownCapture`), so a dispatched `click` measures
 * nothing at all — every outcome looks like a fade. The probe arms the list and
 * then clicks the real buttons.
 *
 * Usage: node probe-new-session-motion.mjs <dshExe> <asarRoot> <dshHome> [profile]
 *
 * The profile argument exists for the negative control: pointing it at a profile
 * linked to the *pre-fix* bundle must make the cross-project assertions fail.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { installRowKeyHelpers } from './lib/row-key.mjs'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-new-session-motion.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}

const PORT = profile === 'pg' ? 17697 : 17698
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout: ${out.slice(-300)}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await installRowKeyHelpers(page)
const logs = []
page.on('pageerror', (error) => { logs.push(`pageerror: ${error.message}`) })

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

/**
 * Arm the animated list.
 *
 * Arming listens for `pointerdown` inside the list, so the event is dispatched
 * rather than clicked: a real click on a row would change the current Session, and
 * which Session is current decides whether the blank row is rendered at all.
 */
const armList = () => page.evaluate(() => {
  const list = document.querySelector('[role="tree"]')
  if (list === null) return false
  list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  return true
})

/**
 * Watch one Session: which group it sits in (per frame) and which animations it
 * runs. Both are needed — the group changes say *when* it moved, the keyframes say
 * *how*, and only together do they distinguish a fade from a glide.
 *
 * Groups are identified by their **row key** (`workspace:<id>`, or the empty id for
 * Ungrouped), not by their visible label: the renderer truncates labels, so two
 * projects whose names share a prefix would be indistinguishable, and an assertion
 * written against a truncated label silently never matches.
 *
 * The Session id is matched after stripping the literal `session-` prefix, because
 * the ids are themselves `session-<uuid>`; a fixed-width slice of the key would
 * capture that prefix and match every row.
 */
const watch = (shortId) => page.evaluate((needle) => {
  const idOf = key => key.startsWith('session:') ? window.__sessionIdOf(key)?.replace(/^session-/, '') ?? '' : ''
  const state = { needle, frames: [], animations: [], mark: null }
  const groupOf = () => {
    const rows = [...document.querySelectorAll('[data-row-key]')]
    let group = '(none)'
    for (const node of rows) {
      const key = node.getAttribute('data-row-key')
      if (key.startsWith('workspace:')) {
        const id = key.slice('workspace:'.length)
        group = id === '' ? 'ungrouped' : id
      } else if (idOf(key).startsWith(needle)) return group
    }
    return '(absent)'
  }
  const tick = () => {
    const value = groupOf()
    const last = state.frames[state.frames.length - 1]
    if (last === undefined || last.value !== value) state.frames.push({ t: Math.round(performance.now()), value })
    window.__watchRaf = requestAnimationFrame(tick)
  }
  tick()
  const original = Element.prototype.animate
  Element.prototype.animate = function (keyframes, options) {
    if (idOf(this.getAttribute?.('data-row-key') ?? '').startsWith(needle)) {
      state.animations.push({
        keyframes: Array.isArray(keyframes)
          ? keyframes.map(frame => Object.keys(frame).filter(k => k !== 'offset').join('+')).join('→')
          : 'obj',
        duration: typeof options === 'object' ? options?.duration : options,
      })
    }
    return original.call(this, keyframes, options)
  }
  window.__watch = state
}, shortId)

const mark = () => page.evaluate(() => { window.__watch.mark = Math.round(performance.now()) })
const read = () => page.evaluate(() => {
  cancelAnimationFrame(window.__watchRaf)
  const { frames, animations, mark: at } = window.__watch
  return { frames, animations, mark: at }
})

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()
const clickPlus = async (title) => {
  const row = projectRow(title)
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
  const plus = row.locator('button[aria-label^="在"]').first()
  const label = await plus.getAttribute('aria-label').catch(() => null)
  await plus.click({ force: true })
  return label
}

/**
 * The group key a Session currently sits under: `ungrouped`, a project id, or
 * null when the row is not rendered at all.
 *
 * Assertions are written against these keys rather than against visible titles,
 * because the renderer truncates titles — two projects sharing a prefix would
 * compare equal, and a check against the truncated text can never match.
 */
const groupKeyOf = (shortId) => page.evaluate((needle) => {
  const rows = [...document.querySelectorAll('[data-row-key]')]
  let group = null
  for (const node of rows) {
    const key = node.getAttribute('data-row-key')
    if (key.startsWith('workspace:')) {
      const id = key.slice('workspace:'.length)
      group = id === '' ? 'ungrouped' : id
    } else if (key.startsWith('session:')) {
      const id = window.__sessionIdOf(key)?.replace(/^session-/, '') ?? ''
      if (id.startsWith(needle)) return group
    }
  }
  return null
}, shortId)

/** The project id behind a project row, found by its visible title. */
const projectIdOf = (title) => page.evaluate((name) => {
  const row = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .find(node => (node.textContent ?? '').includes(name))
  const key = row?.getAttribute('data-row-key') ?? ''
  return key.startsWith('workspace:') ? key.slice('workspace:'.length) : null
}, title)

/** The blank Session's short id, or null when it is not rendered. */
const blankShortId = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-row-key^="session:"]')]
    .find(node => (node.textContent ?? '').includes('新会话'))
  if (row === undefined) return null
  return row.getAttribute('data-row-key').slice('session:'.length).replace(/^session-/, '').slice(0, 8)
})

const fade = (result) => result.animations.some(a => a.keyframes.includes('opacity') && !a.keyframes.includes('transform'))
const glide = (result) => result.animations.some(a => a.keyframes.includes('transform'))

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  // ── Step 0: a real Session, so the blank can be made non-current. ──
  console.log('=== 准备：造一个真实会话（发一条消息）===')
  const composer = page.locator('[contenteditable="true"], textarea').first()
  await composer.click({ force: true })
  await composer.type('1', { delay: 40 })
  await page.keyboard.press('Enter')
  let real = false
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(1500)
    await dismiss()
    const texts = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')]
      .map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 10)))
    if (texts.length > 0 && !texts.some(text => text.includes('新会话'))) { real = true; break }
  }
  check('a real Session exists to make non-current', real)
  /**
   * The non-blank Session row.
   *
   * Not simply the first session row: once the blank has been filed under a
   * project it renders *above* the real one, so `.first()` is the blank and
   * clicking it changes nothing. The blank is identified by the localized
   * "新会话" label the renderer substitutes for a blank row.
   */
  const realRow = () => page.locator('[data-row-key^="session:"]').filter({ hasNotText: '新会话' }).first()

  const stamp = Date.now().toString(36)
  const A = `A${stamp}`
  const B = `B${stamp}`
  for (const title of [A, B]) {
    await dismiss()
    await page.locator('button[aria-label="新建项目"]').first().click()
    await page.waitForTimeout(800)
    await page.locator('input[aria-label="项目名称"]').first().fill(title)
    await page.getByRole('button', { name: '创建' }).first().click()
    await page.waitForTimeout(2500)
  }
  await dismiss()

  // ── Step 1: park the blank under A. ──
  await armList()
  const labelA = await clickPlus(A)
  await page.waitForTimeout(5000)
  await dismiss()
  const parked = await blankShortId()
  const idA = await projectIdOf(A)
  const idB = await projectIdOf(B)
  console.log(`＋ label: ${JSON.stringify(labelA)}`)
  console.log(`blank short id: ${JSON.stringify(parked)}   A=${idA}   B=${idB}`)
  check('both projects have an id', idA !== null && idB !== null, `${idA} / ${idB}`)
  check('the blank Session is filed under the first project',
    await groupKeyOf(parked) === idA, String(await groupKeyOf(parked)))

  // ── Step 2: collapse the blank by selecting the real Session. ──
  await realRow().click({ force: true })
  await page.waitForTimeout(3000)
  await dismiss()
  const collapsed = await groupKeyOf(parked)
  console.log(`blank after selecting another Session: ${JSON.stringify(collapsed)}`)
  check('the blank collapses once another Session is current', collapsed === null, String(collapsed))

  // ── Step 3a: ＋ on the SAME project → must fade. ──
  await watch(parked)
  await page.waitForTimeout(400)
  await mark()
  await clickPlus(A)
  await page.waitForTimeout(5000)
  await dismiss()
  const same = await read()
  console.log(`same project  frames: ${JSON.stringify(same.frames.map(f => `${String(f.t - same.mark)}ms=${f.value}`))}`)
  console.log(`same project  animations: ${JSON.stringify(same.animations)}`)
  check('the same project\'s ＋ fades, like the official sidebar',
    fade(same) && !glide(same), JSON.stringify(same.animations))

  // Re-collapse before the cross-project case.
  await realRow().click({ force: true })
  await page.waitForTimeout(3000)
  await dismiss()
  check('the blank collapses again', await groupKeyOf(parked) === null, String(await groupKeyOf(parked)))

  // ── Step 3b: ＋ on the OTHER project → must also fade. ──
  await watch(parked)
  await page.waitForTimeout(400)
  await mark()
  await clickPlus(B)
  await page.waitForTimeout(5000)
  await dismiss()
  const other = await read()
  console.log(`other project frames: ${JSON.stringify(other.frames.map(f => `${String(f.t - other.mark)}ms=${f.value}`))}`)
  console.log(`other project animations: ${JSON.stringify(other.animations)}`)
  check('another project\'s ＋ does not first render under the old project',
    !other.frames.some(f => f.t >= other.mark && f.value === idA),
    JSON.stringify(other.frames.map(f => f.value)))
  check('and it fades rather than gliding',
    fade(other) && !glide(other), JSON.stringify(other.animations))

  console.log(`\nconsole errors: ${logs.length === 0 ? '(none)' : logs.slice(0, 5).join(' | ')}`)
} finally {
  child.kill()
  await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
