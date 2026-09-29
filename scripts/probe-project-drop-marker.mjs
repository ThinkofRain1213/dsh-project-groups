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
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-project-drop-marker.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17963 : 17964
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
  } catch {
    return []
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
    const rowOf = (title) => [...document.querySelectorAll('[data-row-key^="workspace:"]')]
      .find(node => (node.textContent ?? '').includes(title))
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
  const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
  const table = parsed.tables?.projects ?? {}
  const byTitle = new Map(Object.entries(table).map(([id, row]) => [row.title, id]))
  for (const title of titles) {
    const id = byTitle.get(title)
    if (id === undefined) continue
    await rpc('projectGroups/reorder', { request: { projectId: id } })
    await page.waitForTimeout(200)
  }
  await page.waitForTimeout(700)
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)

  console.log('=== 准备：建 4 个项目，顺序 [A, B, C, D] ===')
  // `create` prepends, so creating in reverse yields the intended display order.
  for (const title of ['D', 'C', 'B', 'A']) {
    const made = await rpc('projectGroups/create', { request: { title } })
    if (made.ok !== true) { console.log(`  建 ${title} 失败: ${JSON.stringify(made.error)}`) }
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(2500)
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
  console.log(`  复位后: ${JSON.stringify(order())}`)
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
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
