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
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile } from './lib/boot-dsh.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-create-motion.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
/** How long the sampler records; the read below waits for exactly this long. */
const WINDOW_MS = 2500
// `join` rather than a hand-written `\\` path, and an overridable port: the literal
// only worked on Windows, and a port already in use surfaced as a boot timeout
// rather than as the collision it was.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17795)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

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
// The boot await sits outside the try/finally that kills this child, so a rejected boot or a
// failed launch would orphan it (and leave the port bound). This closes that window without
// letting the rejection itself go unhandled; the timeout path kills as well.
const killChild = () => { try { child.kill() } catch { /* already gone */ } }
const bootUrl = async () => {
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`))
      }, 120_000)
      // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
      // stdout, so without this handler the promise stayed pending until the 120 s timeout and
      // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
      // the process outright.
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`spawn failed for ${exe}: ${error.message}`))
      })
      // An early exit (bad args, the port already bound, a crash) also never prints a URL, and used
      // to burn the full two minutes before reporting a misleading timeout.
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`dsh exited before printing a URL (code=${String(code)}, signal=${String(signal)}):\n${redactToken(out.slice(-1500))}`))
      })
      child.stdout.on('data', (chunk) => {
        out += String(chunk)
        const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
        if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
      })
      child.stderr.on('data', (chunk) => { out += chunk })
    })
  } catch (error) {
    killChild()
    throw error
  }
}

let browser
let page

/**
 * Neutralise the prototype patch from outside the page.
 *
 * The sampler patches `Element.prototype.animate`; if anything between start and
 * read throws, the patched native prototype would survive for the rest of the
 * session and quietly alter the very animation behaviour being measured.
 */
const restoreSampler = () => page?.evaluate(() => {
  try { window.__sampler?.restore() } catch { /* page gone; nothing left to restore */ }
}).catch(() => {})

try {
  const url = await bootUrl()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))

  const dismiss = () => dismissShared(page)

  const projectRows = () => page.evaluate(() => [...document.querySelectorAll('[data-row-key^="workspace:"]')]
    .map(node => ({
      key: node.getAttribute('data-row-key'),
      title: (node.textContent ?? '').trim().slice(0, 24),
      y: Math.round(node.getBoundingClientRect().top),
    })))

  /**
   * Arm the animated list.
   *
   * `AnimatedRows` starts animating only after the first pointer or keyboard input inside the
   * list (`onPointerDownCapture`), so without this the new row's `animate` calls are never
   * registered and the animation evidence below comes back empty. Dispatched rather than clicked:
   * a real click on a row changes the current Session, which is not this probe's subject.
   *
   * This call existed with no definition anywhere in the file, so `createWhileSampling` threw
   * `ReferenceError: armList is not defined` before it armed anything.
   */
  const armList = () => page.evaluate(() => {
    const list = document.querySelector('[role="tree"]')
    if (list === null) return false
    list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    return true
  })

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
   *
   * `restore` is idempotent and is also reachable from outside via
   * `restoreSampler()`, because a throw between start and read used to leave
   * `Element.prototype.animate` patched for the rest of the session — silently
   * altering the very animation behaviour this probe measures.
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
      windowMs,
      // Idempotent: a second call must not re-disconnect an observer or re-assign
      // the prototype from a stale `original`.
      restored: false,
      restore: () => {
        if (window.__sampler.restored) return
        window.__sampler.restored = true
        observer.disconnect()
        Element.prototype.animate = original
      },
    }
  }, windowMs)

  /**
   * Read the sampler AFTER its recording window has elapsed.
   *
   * The sampler was armed for 4000 ms but read back ~400 ms after the 创建 click, so
   * the declared window and the captured span disagreed: the decisive 首/末 comparison
   * could be made while the row was still mid-flight. The read now waits for the
   * window the sampler was actually given, and prints only the tail of it (the
   * pre-click part of the window is dead time, not signal).
   */
  const readSampler = async () => {
    const windowMs = await page.evaluate(() => window.__sampler?.windowMs ?? 0)
    const deadline = Date.now() + windowMs + 5000
    while (Date.now() < deadline) {
      if (await page.evaluate(() => window.__sampler?.restored === true)) break
      await page.waitForTimeout(100)
    }
    return page.evaluate(() => {
      const r = window.__sampler
      r.restore()
      cancelAnimationFrame(window.__raf)
      return { rafSamples: r.rafSamples, mutSamples: r.mutSamples, animations: r.animations }
    })
  }

  /**
   * Create one project while sampling.
   *
   * `readSampler()` blocks until the recording window has actually elapsed, so the fixed
   * 400 ms wait is gone and the captured span now matches the declared window. The
   * pre-click samples are kept deliberately: they are the baseline rows, and the
   * `beforeKeys` filter below discards them when it looks for the new row — whereas
   * trimming by a clock reading would mean comparing the page's `performance.now()`
   * against the sampler's own relative timestamps, which are not the same origin.
   */
  async function createWhileSampling(title) {
    const before = await projectRows()
    console.log(`\n创建前共 ${before.length} 个项目行:`)
    for (const r of before) console.log(`    y=${String(r.y).padStart(4)}  ${r.key}`)

    await dismiss()
    await page.locator('button[aria-label="新建项目"]').first().click()
    await page.waitForTimeout(700)
    await page.locator('input[aria-label="项目名称"]').first().fill(title)

    await armList()
    await startSampler(WINDOW_MS)
    await page.getByRole('button', { name: '创建' }).first().click()
    return { before, ...await readSampler() }
  }

  const stamp = Date.now().toString(36)
  const NAME = `运动${stamp}`
  /** The new row's key once the project lands, so the decisive check can name it. */
  let createdKey = null

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
      // The y series is the evidence, but a 2.5 s window at mutation granularity can
      // run to hundreds of entries; the distinct values below carry the same
      // information in far less output.
      console.log(`    y 不同取值 ${distinct.length} 个: ${JSON.stringify(distinct.slice(0, 40))}${distinct.length > 40 ? ' …' : ''}`)
      if (distinct.length === 1) console.log(`    ⇒ 只在 y=${distinct[0]}：未移动`)
      else console.log(`    ⇒ 从 y=${distinct[0]} 到 y=${distinct[distinct.length - 1]}：**出现过多个位置**`)
    }
    return added
  }

  // Both traces are printed (they are the evidence); only the MutationObserver result
  // feeds the verdict. `void` makes it explicit that the rAF value is informational,
  // rather than leaving a binding that looks like it decides something.
  void trace(rafSamples, 'rAF 采样（≈用户所见）')
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
    createdKey = key
    console.log(`\n判定 ${key.slice(0, 24)}…  首=${first} 末=${last} 最小=${min} 最大=${max}`)
    if (first > last) console.log('    ★ 首帧在下方、末帧在上方 ⇒ 从下往上滑（与报告一致）')
    else if (min === max) console.log('    y 恒定 ⇒ 未滑动')
    else console.log('    y 有变化但首末同向 ⇒ 需看上面的序列')
  }

  // The probe used to always `process.exit(0)`: a run that never observed the new row
  // — a swallowed locator timeout, a click that did not land — reported the same success
  // to CI as a run that produced the evidence. Success now requires the observation.
  check('the new project row appeared inside the sampling window', createdKey !== null,
    createdKey === null ? 'no new workspace row was seen' : createdKey)
} finally {
  // Best-effort: an exception before `readSampler()` would otherwise leave
  // `Element.prototype.animate` patched in the page for the rest of the run.
  await restoreSampler()
  child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
