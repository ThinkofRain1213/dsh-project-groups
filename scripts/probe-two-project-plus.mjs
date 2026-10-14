/**
 * What happens when two projects each get a ＋ click?
 *
 * Z-3 would make creating a project open a Session, by the same call a project
 * row's ＋ makes. Before adopting that, this measures what the ＋ path actually
 * does when a second project uses it: upstream's `reuseOrCreateBlank` reuses a
 * workspace's single blank Session, and every project here shares one workspace,
 * so the question is whether the second click moves the first project's Session
 * away or leaves it alone.
 *
 * The signal is the Session id itself, not a count: the same id appearing under
 * the second project means it MOVED, while a new id means each project has its
 * own. A count alone could not tell those apart.
 *
 * Usage: node probe-two-project-plus.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-two-project-plus.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a leftover process on this port makes the probe drive the wrong instance (or a
// dead one) and report a misleading verdict instead of a clear error.
const PORT = Number(process.env.DSH_PROBE_PORT ?? 17796)
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

let child
let browser
let page

/**
 * Boot the Host and resolve the tokenised dev-server URL.
 *
 * A function, not top-level code, so both the boot and the browser lifecycle run inside the
 * try/finally below: this file had no guarded region at all, so a boot timeout, a failed launch
 * or a selector timeout left the Host and Chromium behind, and its single `spawn` had no
 * `'error'` listener (an unspawnable exe crashed the process instead of reporting).
 */
const boot = async () => {
  child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  return new Promise((resolve, reject) => {
    let timer
    const fail = (error) => {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      reject(error)
    }
    timer = setTimeout(() => fail(new Error(`boot timeout:\n${redactToken(out.slice(-1500))}`)), 120_000)
    // A failed `spawn` (bad exe path, permission denied) emits `'error'` and never writes to
    // stdout, so without this handler the promise stayed pending until the 120 s timeout and
    // reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes
    // the process outright.
    child.on('error', (error) => fail(new Error(`spawn failed for ${exe}: ${error.message}`)))
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
      if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
    })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('exit', (code) => { fail(new Error(`the Host exited with ${code}`)) })
  })
}

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 8; i += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Later']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        await button.click({ force: true }).catch((error) => console.log(`  (点击「${label}」失败: ${error.message.split('\n')[0]})`))
        await page.waitForTimeout(1200)
        // One click per pass: the first matching label is the visible modal's action, and
        // continuing through the remaining labels clicked controls that are no longer there
        // (each costing another 1.2 s) on every one of the up-to-8 outer iterations.
        break
      }
    }
    await page.waitForTimeout(700)
  }
}

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()

/** Every Session row with the project it is currently drawn under. */
const sessionRows = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-row-key]')]
  let group = null
  const found = []
  for (const node of rows) {
    const key = node.getAttribute('data-row-key')
    if (key.startsWith('workspace:')) { group = key.slice('workspace:'.length); continue }
    if (!key.startsWith('session:')) continue
    // The key is the Session alone; which project a row is drawn under comes from the DOM
    // position (the `workspace:` heading above it), not from the key.
    found.push({ id: key.slice('session:'.length), drawnUnder: group })
  }
  return found
})

const makeProject = async (title) => {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

const clickPlus = async (title) => {
  const row = projectRow(title)
  await row.hover({ timeout: 5000 }).catch((error) => console.log(`  (hover ${title} 失败: ${error.message.split('\n')[0]})`))
  await page.waitForTimeout(400)
  await row.locator('button[aria-label^="在"]').first().click({ force: true })
  await page.waitForTimeout(3000)
}

const report = async (label, keyA, keyB) => {
  const rows = await sessionRows()
  // Filtered by the group each row is drawn under, since the key no longer carries it.
  const a = rows.filter(r => r.drawnUnder === keyA)
  const b = rows.filter(r => r.drawnUnder === keyB)
  console.log(`\n--- ${label}`)
  console.log(`    A 名下会话: ${a.length === 0 ? '(无)' : a.map(r => r.id.slice(-8)).join(',')}`)
  console.log(`    B 名下会话: ${b.length === 0 ? '(无)' : b.map(r => r.id.slice(-8)).join(',')}`)
  return { a: a.map(r => r.id), b: b.map(r => r.id) }
}

let aborted = null
try {
  const url = await boot()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(7000)
  await dismiss()

  const stamp = Date.now().toString(36)
  const A = `甲${stamp}`
  const B = `乙${stamp}`
  await makeProject(A)
  await makeProject(B)

  const keyA = (await projectRow(A).getAttribute('data-row-key') ?? '').replace('workspace:', '')
  const keyB = (await projectRow(B).getAttribute('data-row-key') ?? '').replace('workspace:', '')
  console.log(`项目 A=${A} (${keyA.slice(0, 8)}…)  B=${B} (${keyB.slice(0, 8)}…)`)
  // The premise of every reading below: without a group key the filters match nothing and every
  // "A 名下: (无)" line would be an artefact of a missing key rather than a measurement.
  check('前提：两个项目行都渲染且有 key', keyA !== '' && keyB !== '',
    `keyA=${JSON.stringify(keyA)} keyB=${JSON.stringify(keyB)}`)

  const before = await report('两个项目刚建好，未点任何 ＋', keyA, keyB)
  await clickPlus(A)
  const afterA = await report('点了 A 的 ＋', keyA, keyB)
  await clickPlus(B)
  const afterB = await report('又点了 B 的 ＋', keyA, keyB)

  console.log('\n================ 判定 ================')
  // "MOVED" is decided against every id A was ever seen holding — the snapshot from before the
  // clicks *and* the one after A's ＋ — not only `afterA.a`. With a single snapshot, a Session
  // that A held at `before` and lost by `afterA` (or the reverse) fell outside the intersection
  // and B's identical id was then read as a new Session.
  const aIds = new Set([...before.a, ...afterA.a])
  const bIds = new Set(afterB.b)
  const movedIds = [...bIds].filter(id => aIds.has(id))
  console.log(`点 A 的 ＋ 后，A 名下: ${afterA.a.join(',') || '(无)'}`)
  console.log(`点 B 的 ＋ 后，A 名下: ${afterB.a.join(',') || '(无)'}   B 名下: ${afterB.b.join(',') || '(无)'}`)
  if (movedIds.length > 0) {
    console.log(`★ 同一批会话 id 曾出现在 A 名下、现在挂在 B 名下 ⇒ 第二个 ＋ 把会话挪走了: ${movedIds.join(',')}`)
  } else if (afterB.a.length > 0 && afterB.b.length > 0) {
    console.log('两个项目各自持有会话 ⇒ 未发生争抢')
  } else if (afterB.a.length === 0 && afterB.b.length > 0) {
    // Reached only when B's ids are disjoint from every id A was seen holding, so B's Session is
    // NOT the one that was under A. Calling this "moved" was backwards: A lost its row and B has
    // an id A never held, which is a new Session plus a disappeared one — not a move.
    console.log('A 名下已空，B 名下的会话 id 与 A 曾持有的都不同 ⇒ 不是"移走"：A 的会话消失，B 的是另一个会话')
  } else {
    console.log('结果需人工判读')
  }
  console.log(`\n（首个报告对照）点之前: A=${before.a.length} B=${before.b.length}`)
  // The measurement's precondition, asserted rather than assumed: if A's ＋ filed nothing under
  // A, every comparison above is about an empty set and the verdict means nothing.
  check('前提：A 的 ＋ 之后 A 名下至少有一个会话', afterA.a.length > 0, JSON.stringify(afterA))
} catch (error) {
  aborted = error
  check('探针跑完而没有中途异常', false, String(error?.message ?? error))
} finally {
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}

console.log(`\n${failures.length === 0 ? 'MEASUREMENT COMPLETED' : `${failures.length} CHECK(S) FAILED`}`)
if (aborted !== null) console.log(`  运行在测量中途终止: ${String(aborted?.message ?? aborted)}`)
process.exit(failures.length === 0 ? 0 : 1)
