/**
 * Measure the flash on 默认 ⇄ 指定.
 *
 * "只探查" — this changes nothing; it watches the two cards while the toggle is clicked and
 * reports every state change with a timestamp, so the flash is identified by evidence
 * rather than by reading the render path and guessing.
 *
 * What is sampled, per tick:
 *   - `aria-pressed` on both cards (which one is *selected*);
 *   - the 指定 card's subtitle text (what it *claims* the chosen Workspace is);
 *   - the class list of the 指定 card (independent of aria, in case only styling moves).
 *
 * Also sampled: every `projectGroups` round trip (via the page's responses), since a flash
 * between an optimistic write and the frame that supersedes it is the shape to look for. The
 * in-page sampler runs on its own animation frame, so a transition shorter than the poll
 * interval is still caught.
 *
 * Usage: node probe-base-workspace-toggle-flash.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-toggle-flash.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a leaked Host from an earlier failed run keeps this port bound, and a silent
// collision shows up only as a boot that hangs until the 120 s timeout.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17940 : 17941))
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/**
 * The checkout this probe's fixture Workspace points at.
 *
 * This was a literal `C:\Users\Think\Desktop\项目\dsh-project-groups...` string, which baked
 * one developer's filesystem into the probe: on any other machine the Workspace either failed
 * to register or registered the **wrong** directory, and the sections below then measured
 * something else with nothing in the output to say so.
 *
 * Defaults to the working directory, which is how the usage line already expects this to be
 * run, and can be overridden with `DSH_PROBE_REPO_ROOT`.
 */
const repoRoot = process.env.DSH_PROBE_REPO_ROOT ?? process.cwd()
// Resolved on the Node side: this value has to cross into `page.evaluate` as an argument. A
// `join(repoRoot, 'scripts')` written *inside* the evaluate body ran in the browser, where
// neither name exists, and threw `join is not defined` before the seed request was sent.
const seedPath = join(repoRoot, 'scripts')
const seedName = basename(seedPath)

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
 * A function, not top-level code, so the boot path runs inside the try/finally below: a boot
 * timeout used to reject before the guarded region was entered, so neither the spawned Host nor
 * the browser was ever cleaned up.
 */
const boot = async () => {
  child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  return new Promise((resolve, reject) => {
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
}

const traffic = []
const recordResponse = async (response) => {
  if (!response.url().includes('/api/projectGroups/')) return
  const method = response.url().split('/api/')[1]
  let body = ''
  try { body = (await response.text()).slice(0, 160) } catch { body = '(unreadable)' }
  traffic.push({ at: Date.now(), method, status: response.status(), body })
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
      }
    }
    await page.waitForTimeout(700)
  }
}

/**
 * The stored memory, or `null` when there is genuinely none.
 *
 * "No file / no section yet" and "the file could not be read" used to collapse into the same
 * `null`, so a corrupted store flowed into the final assertions as a bogus 'no memory' verdict
 * and hid the real cause. A read/parse failure is now printed.
 */
const storedBase = () => {
  let raw
  try {
    raw = readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') console.log(`  (project_groups.json 无法读取: ${error.message})`)
    return null
  }
  try {
    return JSON.parse(raw).global?.baseWorkspace ?? null
  } catch (error) {
    console.log(`  (project_groups.json 不是合法 JSON: ${error.message})`)
    return null
  }
}

const card = () => page.locator('[data-plugin-config]').first()

/**
 * Start an in-page sampler. It records on every animation frame, so a one-frame
 * intermediate render is captured even though the driver polls far slower.
 */
const startSampling = () => page.evaluate(() => {
  window.__flashLog = []
  const read = () => {
    const section = document.querySelector('[data-plugin-config]')
    if (section === null) return null
    const cards = [...section.querySelectorAll('button[aria-pressed]')]
    if (cards.length !== 2) return null
    const [first, second] = cards
    // The 指定 card's subtitle is its second span; the name/hint is the first.
    const spans = [...second.querySelectorAll('span')]
    return {
      pressed: `${first.getAttribute('aria-pressed')}/${second.getAttribute('aria-pressed')}`,
      // Drop the trailing "更换…" control text from the comparison.
      subtitle: (spans[1]?.textContent ?? '').trim(),
      selectedClass: second.className.includes('selected'),
    }
  }
  let previous = null
  const tick = () => {
    const now = read()
    if (now !== null) {
      const key = `${now.pressed}|${now.subtitle}|${String(now.selectedClass)}`
      if (key !== previous) {
        window.__flashLog.push({ t: performance.now(), ...now })
        previous = key
      }
    }
    window.__flashRaf = requestAnimationFrame(tick)
  }
  window.__flashRaf = requestAnimationFrame(tick)
})

const readSamples = () => page.evaluate(() => {
  cancelAnimationFrame(window.__flashRaf)
  return window.__flashLog ?? []
})

/**
 * Start the sampler, click `target`, and return the state changes it recorded.
 *
 * Extracted because the three scenarios were copy-pasted whole (start → click → wait → read →
 * print), and the printing loops then had to be kept in sync with each other by hand.
 */
const sampleTransition = async (target, label) => {
  console.log('')
  console.log(`=== ${label}（逐帧采样）===`)
  await startSampling()
  await target.click({ force: true })
  await page.waitForTimeout(4000)
  const samples = await readSamples()
  // Guarded: with no recorded change, `samples[0].t` used to throw a TypeError inside the
  // report and abort the probe with a stack trace instead of the scenario's verdict.
  if (samples.length === 0) console.log('  （采样器没有记录到任何状态变化）')
  for (const sample of samples) {
    console.log(`  +${(sample.t - samples[0].t).toFixed(1)}ms  pressed=${sample.pressed}  selected=${String(sample.selectedClass)}  副标题=${JSON.stringify(sample.subtitle)}`)
  }
  console.log(`  磁盘: ${JSON.stringify(storedBase())}`)
  return { label, samples }
}

try {
  const url = await boot()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  // Registered after `newPage()`, not at module scope: at module scope it ran against an
  // undefined `page` and threw before the browser had launched.
  page.on('response', (response) => { void recordResponse(response) })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  await page.locator('text=dsh-project-groups').first().click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()

  const defaultCard = card().locator('button[aria-pressed]').filter({ hasText: '默认工作区' }).first()
  const specifiedCard = card().locator('button[aria-pressed]').filter({ hasText: '指定工作区' }).first()

  // Seed a memory first, or the toggle never reaches the write path: with nothing stored,
  // clicking 指定 opens the chooser and writes nothing, so there is no optimistic paint to
  // compare against the Host's frame.
  //
  // The response is read and asserted. It used to be discarded, so a failed or rejected
  // `workspace/create` (a bad or expired token, a non-2xx status) was silently ignored — and the
  // sampling below then measured a different state than intended, reporting a misleading
  // 'flash'/'no memory' verdict instead of the real setup failure.
  const seed = await page.evaluate(async ({ path }) => {
    const token = new URL(location.href).searchParams.get('token') ?? ''
    const response = await fetch(`${location.origin}/api/workspace/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'w', method: 'workspace/create',
        payload: { args: { request: { path } } },
      }),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* reported through status */ }
    return { status: response.status, ok: parsed?.result?.ok, error: parsed?.result?.error, text: text.slice(0, 200) }
  }, { path: seedPath })
  check('前置：种子 workspace/create 成功', seed.status === 200 && seed.ok !== false,
    `status=${String(seed.status)} ok=${String(seed.ok)} error=${JSON.stringify(seed.error)} body=${seed.text}`)
  if (seed.status !== 200 || seed.ok === false) {
    throw new Error(`the seed workspace/create failed (status ${String(seed.status)}); the sampling below would measure the wrong state`)
  }
  await page.waitForTimeout(1200)
  await specifiedCard.click({ force: true })
  await page.waitForTimeout(1200)
  const chooser = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
  if (await chooser.count() > 0) {
    await chooser.locator('[role="option"]').first().click({ force: true })
    await chooser.getByRole('button', { name: '确认' }).first().click({ force: true })
    await page.waitForTimeout(2000)
  }
  console.log('=== 起点 ===')
  console.log(`  磁盘记忆: ${JSON.stringify(storedBase())}`)
  console.log(`  卡片文字: ${JSON.stringify((await card().innerText()).replace(/\s+/g, ' ').slice(0, 160))}`)

  // Back to 默认 before the first scenario: the seed above ended on 指定, so clicking the
  // already-selected 指定 card is a no-op and never produces the 默认→指定 frame this scenario
  // exists to measure.
  await defaultCard.click({ force: true })
  await page.waitForTimeout(2000)

  const t0 = Date.now()
  const transitions = [
    await sampleTransition(specifiedCard, '点击「指定工作区」'),
    await sampleTransition(defaultCard, '点击「默认工作区」'),
    await sampleTransition(specifiedCard, '再次点击「指定工作区」（用户说的"切换回来闪烁"）'),
  ]

  console.log('')
  console.log('=== 附带断言：已经是「默认」时再点一次「默认」，不该有写请求 ===')
  //
  // `setBaseWorkspace` compares the *incoming* object against the stored one before
  // deciding it is a no-op. Before the normalisation fix, a caller sending
  // `{ mode: 'default' }` with no path could never equal a stored
  // `{ mode: 'default', path, name }`, so the guard could not fire and every click on the
  // already-selected 默认 card issued a redundant round trip. Now it is normalised first,
  // so the second click must be zero.
  //
  // Two clicks are needed: the sequence above ends on 指定, so the first 默认 click
  // is a real change and must write. Only the repeat is expected to be a no-op.
  await defaultCard.click({ force: true })
  await page.waitForTimeout(2000)
  const firstDefault = traffic.length
  await defaultCard.click({ force: true })
  await page.waitForTimeout(2500)
  const idleWrites = traffic.slice(firstDefault)
  console.log(`  第二次点击（已是默认）产生的请求: ${String(idleWrites.length)}`)
  for (const entry of idleWrites) console.log(`    ${entry.method} → ${String(entry.status)}`)

  console.log('')
  console.log('=== 网络时序（相对第一次点击）===')
  for (const entry of traffic) {
    console.log(`  +${String(entry.at - t0)}ms  ${entry.method} → ${String(entry.status)}`)
    console.log(`      ${entry.body}`)
  }

  console.log('')
  console.log('=== 判读 ===')
  for (const { label, samples } of transitions) {
    const intermediate = samples.filter((sample, index) => index > 0 && index < samples.length - 1)
    console.log(`  ${label}: ${String(samples.length)} 个状态变化${intermediate.length === 0 ? '（无中间态）' : `，含 ${String(intermediate.length)} 个中间态：`}`)
    for (const mid of intermediate) {
      console.log(`      中间态 pressed=${mid.pressed} 副标题=${JSON.stringify(mid.subtitle)}`)
    }
  }

  console.log('')
  console.log('=== 断言 ===')
  //
  // Per-frame, not per-poll. The earlier card probe sampled once 1800ms after the click
  // and therefore stepped straight over the offending frame — which is exactly how this
  // defect survived its own acceptance run. `requestAnimationFrame` is what makes the
  // intermediate render observable at all.
  for (const { label, samples } of transitions) {
    const subtitles = samples.map(sample => sample.subtitle)
    check(`${label}：副标题不出现「未选择」中间态`,
      !subtitles.includes('未选择'), JSON.stringify(subtitles))
    // The selected card must never be "neither": exactly one card is pressed after settling.
    const settled = samples[samples.length - 1]
    check(`${label}：稳定后恰好一张卡片被选中`,
      settled !== undefined && (settled.pressed === 'true/false' || settled.pressed === 'false/true'),
      String(settled?.pressed))
  }
  check('重复点已选中的卡片不产生写请求', idleWrites.length === 0, `${String(idleWrites.length)} 次`)
  // The memory must still be on disk after the whole sequence, and the toggle must have
  // actually moved: a probe that asserted "no flash" while nothing changed would pass
  // vacuously. Read once — three separate reads let the file change between the comparison and
  // the diagnostic, and `path !== undefined` was true for a stored `null`.
  const finalMemory = storedBase()
  check('整轮结束后磁盘仍带记忆',
    typeof finalMemory?.path === 'string' && finalMemory.path !== '' && finalMemory.name === seedName,
    JSON.stringify(finalMemory))
  check('整轮结束后停在「默认」且记忆仍在',
    finalMemory?.mode === 'default' && typeof finalMemory?.path === 'string' && finalMemory.path !== '',
    JSON.stringify(finalMemory))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  if (child !== undefined) child.kill()
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
process.exit(failures.length === 0 ? 0 : 1)
