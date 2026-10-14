/**
 * Does a project drop land where the marker showed?
 *
 * Reported: the blue insertion line sat **above** `dsh-project-groups`, but releasing put the row
 * **below** it. Two independent causes can produce a landing lower than the marker, and this probe
 * separates them.
 *
 * ## Cause 1 — the committed side was recomputed, not the one shown
 *
 * The marker renders from drag state (`markerOver.half`), but `dropWorkspace` measures the side
 * again from the drop event's coordinates. `drop` fires at release, so any movement across the row's
 * mid-point after the last `dragover` flips the side — and the commit clears the state before React
 * repaints, so the line the user saw is gone and the row lands on a side that was never marked.
 *
 * Note this recomputation is **upstream's own** behaviour for Workspace rows (`dsh-client-ui-workspace`
 * has the same `dropWorkspace`), and this repo's session path relies on it deliberately ("a handler's
 * closed state can predate the last dragOver"). So the fix is scoped to the **project** branch, which
 * is this plugin's own code, and the Workspace path stays byte-for-byte upstream's.
 *
 * ## Cause 2 — `'after'` meant "append to the end", not "after this row"
 *
 * The project branch passed `undefined` for `'after'`, and the Host's `reorder` reads
 * `beforeId === undefined` as "put it last". A marker drawn under one project therefore landed the
 * row at the bottom of the list unless that project was already last. The Workspace branch resolves
 * `'after'` to the **next** sibling; the project branch now does the same.
 *
 * ## Method
 *
 * Both scenarios start from the same order, `[A, B, C, D]`, and drag `A`:
 *
 *   1. hover C's upper half (marker above C), release in C's **lower** half — the divergence that
 *      reproduces the report. Honouring the marker gives `[B, A, C, D]`; recomputing gives
 *      `[B, C, A, D]`.
 *   2. hover and release in B's lower half — a marker that is genuinely "after B". Resolving the
 *      next sibling gives `[B, A, C, D]`; passing no anchor gives `[B, C, D, A]`.
 *
 * Usage: node probe-project-drop-marker.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-drop-marker.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17963 : 17964))
// `join` rather than Windows-only separators, for the same reason the module already uses it
// for the domain path: the backslash literal is an invalid path on a POSIX host.
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Uncaught page exceptions. Asserted at the end: a drop handler that throws must not pass. */
const pageErrors = []

// Spawned inside the `try` below, so a failed spawn, a boot timeout or a launch error all
// still reach the `finally` that reaps the Host. While the spawn sat above the `try`, a boot
// timeout rejected the top-level await and left the Electron Host holding `PORT`.
let child
let browser
let page

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

/** The durable order, as project **titles**, which is what the assertions read. */
const order = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
    const global = parsed.global ?? {}
    const table = parsed.tables?.projects ?? {}
    return (global.projectIds ?? []).map(id => table[id]?.title ?? `?${String(id).slice(0, 6)}`)
  } catch (error) {
    // Only "the file is not there yet" means an empty list. Swallowing every error made a
    // corrupt or wrong-`dshHome` domain read as an empty order, so the very first check
    // reported `FAIL 起点顺序是 [A, B, C, D]` with an empty detail instead of the real cause.
    if (error?.code === 'ENOENT') return []
    throw new Error(`cannot read the project order from ${join(dshHome, 'storages', 'project_groups.json')}: ${String(error?.message ?? error)}`)
  }
}

/**
 * Dispatch one drag: `dragstart` on the source row, `dragover` at the hover position, then a React
 * render tick, then `drop` at the release position and `dragend`.
 *
 * The two positions are given as fractions of the target section's height so the hover and the
 * release can deliberately disagree across the mid-point — that divergence is the reported bug.
 *
 * A render tick after `dragstart` is **required**: the section's `onDragOver` is only attached once
 * `workspaceDrag` is non-null, and that state lands on the next paint. Dispatching `dragover`
 * synchronously after `dragstart` therefore hits a section with no handler, no marker is ever set,
 * and the scenario silently stops testing anything — which is exactly how the first version of this
 * probe "failed".
 */
const dragProject = async ({ sourceTitle, targetTitle, hoverFraction, dropFraction }) => page.evaluate(
  async ({ sourceTitle, targetTitle, hoverFraction, dropFraction }) => {
    // Among the rows whose accumulated text contains the title, the shortest one is the intended
    // row: a bare `includes` with single-letter titles (`A`…`D`) can match a row whose text merely
    // contains that letter — a path fragment, a badge — and then the drag would start or land on
    // the wrong row, which is a measurement of the harness rather than of the behaviour.
    const rowOf = (title) => [...document.querySelectorAll('[data-row-key^="workspace:"]')]
      .filter(node => (node.textContent ?? '').includes(title))
      .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]
    const sectionOf = (title) => rowOf(title)?.closest('[class*="groupSection"]') ?? null
    const source = rowOf(sourceTitle)
    const target = sectionOf(targetTitle)
    if (source === undefined || target === null) {
      return { error: `row not found (source=${String(source)}, target=${String(target)})` }
    }
    const dataTransfer = new DataTransfer()
    const rect = target.getBoundingClientRect()
    const yAt = (fraction) => rect.top + rect.height * fraction
    const fire = (type, y) => target.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: y, dataTransfer,
    }))
    const tick = () => new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)) })
    source.dispatchEvent(new DragEvent('dragstart', {
      bubbles: true, cancelable: true, dataTransfer,
    }))
    // Let the drag state land, or the section has no `dragover` handler yet.
    await tick()
    fire('dragover', yAt(hoverFraction))
    await tick()
    // What the user can see at this instant: the marker class on the target's section.
    // CSS modules prefix the class (`<hash>_workspaceDropBefore`), so a substring test is right.
    const markerBefore = target.className.includes('workspaceDropBefore') ? 'before'
      : target.className.includes('workspaceDropAfter') ? 'after' : null
    fire('drop', yAt(dropFraction))
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
    return { markerBefore, rectHeight: Math.round(rect.height * 100) / 100 }
  },
  { sourceTitle, targetTitle, hoverFraction, dropFraction },
)

/**
 * Restore an exact project order through the Host.
 *
 * `reorder` appends when it gets no anchor, so moving each title **in forward order** leaves the
 * list in exactly the order given — the first version walked the list backwards and produced the
 * reverse. Waiting a tick per move keeps the writes from racing on the domain's queue.
 */
const restoreOrder = async (titles) => {
  // Guarded and named: the unguarded `JSON.parse` here was the only storage read without error
  // handling, and a failure at this point used to surface as scenario 2 measuring an order that
  // had never been restored.
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
  } catch (error) {
    throw new Error(`cannot read the domain to restore the order: ${String(error?.message ?? error)}`)
  }
  const table = parsed.tables?.projects ?? {}
  const byTitle = new Map(Object.entries(table).map(([id, row]) => [row.title, id]))
  for (const title of titles) {
    const id = byTitle.get(title)
    if (id === undefined) continue
    const moved = await rpc('projectGroups/reorder', { request: { projectId: id } })
    if (moved.ok !== true) console.log(`  复位 ${title} 失败: ${JSON.stringify(moved.error)}`)
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(700)
}

try {
  child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
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

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  // Readiness instead of a bare 8 s: the sidebar must have rendered a project row before the
  // RPCs below are expected to show up in it, and "has a row" is the condition this probe
  // actually needs. The remaining short waits below are animation/settle windows around drags
  // and Host writes, which expose no completion signal to poll for.
  await page.waitForFunction(
    () => document.querySelector('[data-row-key^="workspace:"]') !== null,
    null, { timeout: 30_000 },
  )

  console.log('=== 准备：建 4 个项目，顺序 [A, B, C, D] ===')
  // `create` prepends, so creating in reverse yields the intended display order.
  for (const title of ['D', 'C', 'B', 'A']) {
    const made = await rpc('projectGroups/create', { request: { title } })
    if (made.ok !== true) { console.log(`  建 ${title} 失败: ${JSON.stringify(made.error)}`) }
    await page.waitForTimeout(400)
  }
  // Poll for the four rows instead of sleeping: the `create` RPC returns before the sidebar has
  // re-rendered them, and a stale DOM here makes `dragProject` drag nothing (or the wrong row).
  await page.waitForFunction(
    () => document.querySelectorAll('[data-row-key^="workspace:"]:not([data-row-key="workspace:"])').length >= 4,
    null, { timeout: 30_000 },
  )
  console.log(`  当前顺序: ${JSON.stringify(order())}`)
  check('起点顺序是 [A, B, C, D]', order().join(',') === 'A,B,C,D', order().join(','))

  console.log('')
  console.log('=== 场景 1（修 1）：线在 C 上方，却在 C 的下半松手 ===')
  const one = await dragProject({
    sourceTitle: 'A', targetTitle: 'C', hoverFraction: 0.2, dropFraction: 0.8,
  })
  console.log(`  拖拽派发: ${JSON.stringify(one)}`)
  check('线确实画在 C 上方（前提成立）', one.markerBefore === 'before', String(one.markerBefore))
  await page.waitForTimeout(1500)
  const afterOne = order()
  console.log(`  落地顺序: ${JSON.stringify(afterOne)}`)
  check('1) 落点等于画出的线（A 落在 C 之前）',
    afterOne.join(',') === 'B,A,C,D', afterOne.join(','))
  check('1) 没有落到"重算后的下半"（B,C,A,D）',
    afterOne.join(',') !== 'B,C,A,D', afterOne.join(','))

  console.log('')
  console.log('=== 场景 2（修 2）：线在 B 下方，也在 B 的下半松手 ===')
  await restoreOrder(['A', 'B', 'C', 'D'])
  const restored = order().join(',')
  console.log(`  复位后: ${JSON.stringify(order())}`)
  // The reset is verified before scenario 2 runs: an unverified reset would let the next
  // assertions pass or fail against whatever order the previous scenario left behind.
  check('复位后顺序回到 [A, B, C, D]（场景 2 的前提）', restored === 'A,B,C,D', restored)
  const two = await dragProject({
    sourceTitle: 'A', targetTitle: 'B', hoverFraction: 0.8, dropFraction: 0.8,
  })
  console.log(`  拖拽派发: ${JSON.stringify(two)}`)
  check('线画在 B 下方（前提成立）', two.markerBefore === 'after', String(two.markerBefore))
  await page.waitForTimeout(1500)
  const afterTwo = order()
  console.log(`  落地顺序: ${JSON.stringify(afterTwo)}`)
  check('2) 落在 B 之后【紧邻】，而不是列表末尾',
    afterTwo.join(',') === 'B,A,C,D', afterTwo.join(','))
  check('2) 没有落到末尾（B,C,D,A）',
    afterTwo.join(',') !== 'B,C,D,A', afterTwo.join(','))

  console.log('')
  console.log('=== 结果 ===')
  // Asserted, not just logged: an uncaught exception on the page (a drop handler throwing is
  // exactly what this probe exists to catch) could otherwise end the run with ALL CHECKS PASSED.
  check('页面没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  // Guarded: the spawn is inside the `try` now, so a synchronous spawn failure must not turn the
  // real error into a `TypeError` from this line.
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
process.exit(failures.length === 0 ? 0 : 1)
