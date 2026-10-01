/**
 * Where a newly created project appears, measured per frame.
 *
 * Z-1 reports that a new project slides up from the bottom, while a new official
 * Workspace simply appears. The static reasoning behind the fix was wrong once
 * already, so this measures instead: it samples every project row each animation
 * frame across the creation, recording each row's key and y with no
 * deduplication, plus which animations ran and their keyframes.
 *
 * The signals, and why each is the right one:
 *
 *   - **y per frame, undeduped**, so travel shows as a run of intermediate
 *     positions while "appeared in place" shows one value;
 *   - **the row-key list per frame**, so the ordering the DOM actually had is
 *     visible even if a row is replaced rather than moved;
 *   - **the animation keyframes**, because a fade is `opacity→opacity` and a
 *     glide is `transform+opacity→transform+opacity` — and a row can carry a
 *     transform and still be pinned at one coordinate, which is the false
 *     positive this style of probe exists to avoid.
 *
 * Usage: node probe-project-create-motion.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-create-motion.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = 17795
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

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

const projectRows = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key^="workspace:"]')]
  .map(node => ({
    key: node.getAttribute('data-row-key'),
    title: (node.textContent ?? '').trim().slice(0, 24),
    y: Math.round(node.getBoundingClientRect().top),
  })))

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(7000)
await dismiss()

/**
 * Sample every project row for `windowMs` from TWO sources.
 *
 * rAF alone is not enough here. Headless Chromium throttles animation frames when
 * little is being painted — measured at ~180 ms per frame in this probe — so a
 * transient that lives for one or two real frames can fall entirely between
 * samples and be reported as "never moved". That is exactly the failure this
 * probe would otherwise hide, so a MutationObserver records the row set
 * synchronously on every DOM change as well; together they bracket the window
 * from both ends.
 */
const startSampler = (windowMs) => page.evaluate((windowMs) => {
  const rafSamples = []
  const mutSamples = []
  const animations = []
  const start = performance.now()

  const readRows = () => [...document.querySelectorAll('[data-row-key^="workspace:"]')].map(node => ({
    key: node.getAttribute('data-row-key'),
    y: Math.round(node.getBoundingClientRect().top),
  }))
  const now = () => Math.round(performance.now() - start)

  const sample = () => {
    rafSamples.push({ t: now(), rows: readRows() })
    if (performance.now() - start < windowMs) window.__raf = requestAnimationFrame(sample)
  }

  // Fires on every insertion/removal/reorder in the sidebar subtree, i.e. on each
  // DOM state the user could actually have seen, regardless of frame pacing.
  const observer = new MutationObserver(() => {
    if (performance.now() - start < windowMs) mutSamples.push({ t: now(), rows: readRows() })
  })
  const root = document.querySelector('[role="tree"]') ?? document.body
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key'] })

  const original = Element.prototype.animate
  Element.prototype.animate = function (keyframes, options) {
    const key = this.getAttribute?.('data-row-key') ?? ''
    if (key.startsWith('workspace:')) {
      animations.push({
        key,
        at: now(),
        frames: Array.isArray(keyframes)
          ? keyframes.map(f => Object.keys(f).filter(k => k !== 'offset').join('+')).join('→')
          : 'obj',
        duration: typeof options === 'object' ? options?.duration : options,
      })
    }
    return original.call(this, keyframes, options)
  }

  sample()
  window.__sampler = {
    rafSamples,
    mutSamples,
    animations,
    restore: () => { observer.disconnect(); Element.prototype.animate = original },
  }
}, windowMs)

const readSampler = () => page.evaluate(() => {
  cancelAnimationFrame(window.__raf)
  window.__sampler.restore()
  const r = window.__sampler
  return { rafSamples: r.rafSamples, mutSamples: r.mutSamples, animations: r.animations }
})

const armList = () => page.evaluate(() => {
  document.querySelector('[role="tree"]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
})

/** Create one project while sampling. Returns the samples for that window. */
async function createWhileSampling(title) {
  const before = await projectRows()
  console.log(`\n创建前共 ${before.length} 个项目行:`)
  for (const r of before) console.log(`    y=${String(r.y).padStart(4)}  ${r.key}`)

  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(700)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)

  await armList()
  await startSampler(4000)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(400)
  return { before, ...await readSampler() }
}

const stamp = Date.now().toString(36)
const NAME = `运动${stamp}`

// Two projects first, so a new row has something to be "above" and the
// bottom-vs-top question is visible in the coordinates.
for (const t of [`底一${stamp}`, `底二${stamp}`]) {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(600)
  await page.locator('input[aria-label="项目名称"]').first().fill(t)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2200)
}

const { before, rafSamples, mutSamples, animations } = await createWhileSampling(NAME)

// Which key is new relative to `before`, and did it ever sit anywhere but its
// final y? Both samplers are folded together — the observer's synchronous record
// is the one that cannot miss a transient, and rAF is the one that matches what a
// human sees; reporting them apart shows when they disagree.
const beforeKeys = new Set(before.map(r => r.key))

function trace(samples, label) {
  const firstSeen = new Map()
  for (const s of samples) {
    for (const row of s.rows) {
      if (!firstSeen.has(row.key)) firstSeen.set(row.key, { firstT: s.t, ys: [] })
      firstSeen.get(row.key).ys.push(row.y)
    }
  }
  const added = [...firstSeen.entries()].filter(([key]) => !beforeKeys.has(key))
  console.log(`\n===== ${label}: ${samples.length} 次采样 =====`)
  if (added.length === 0) console.log('    窗口内没有新行键出现')
  for (const [key, info] of added) {
    const distinct = [...new Set(info.ys)]
    console.log(`  新行 ${key.slice(0, 24)}… 首次 t=${info.firstT}ms，有值 ${info.ys.length} 次`)
    console.log(`    y 不同取值 ${distinct.length} 个: ${JSON.stringify(distinct)}`)
    if (distinct.length === 1) console.log(`    ⇒ 只在 y=${distinct[0]}：未移动`)
    else console.log(`    ⇒ 从 y=${distinct[0]} 到 y=${distinct[distinct.length - 1]}：**出现过多个位置**`)
  }
  return added
}

const addedRaf = trace(rafSamples, 'rAF 采样（≈用户所见）')
const addedMut = trace(mutSamples, 'MutationObserver（不漏瞬态）')

console.log(`\n===== 该窗口针对项目行的动画 =====`)
if (animations.length === 0) console.log('    (无)')
for (const a of animations) {
  console.log(`    t=${String(a.at).padStart(5)}ms  ${a.key.slice(0, 24)}…  ${a.frames}  ${String(a.duration)}ms`)
}

// The decisive question: did the new row ever sit BELOW its final position?
for (const [key, info] of addedMut) {
  const ys = info.ys
  const first = ys[0]
  const last = ys[ys.length - 1]
  const min = Math.min(...ys)
  const max = Math.max(...ys)
  console.log(`\n判定 ${key.slice(0, 24)}…  首=${first} 末=${last} 最小=${min} 最大=${max}`)
  if (first > last) console.log('    ★ 首帧在下方、末帧在上方 ⇒ 从下往上滑（与报告一致）')
  else if (min === max) console.log('    y 恒定 ⇒ 未滑动')
  else console.log('    y 有变化但首末同向 ⇒ 需看上面的序列')
}

await browser.close()
child.kill()
process.exit(0)
