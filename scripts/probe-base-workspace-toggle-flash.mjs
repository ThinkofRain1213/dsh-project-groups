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
 * Also sampled: every `projectGroups` round trip and every Host `follow` frame, since a
 * flash between an optimistic write and the frame that supersedes it is the shape to look
 * for. The in-page sampler runs on its own interval and pushes into an array, so a
 * transition shorter than the poll interval is still caught.
 *
 * Usage: node probe-base-workspace-toggle-flash.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-toggle-flash.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17940 : 17941
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
const traffic = []
page.on('response', async (response) => {
  if (!response.url().includes('/api/projectGroups/')) return
  const method = response.url().split('/api/')[1]
  let body = ''
  try { body = (await response.text()).slice(0, 160) } catch { body = '(unreadable)' }
  traffic.push({ at: Date.now(), method, status: response.status(), body })
})

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

const storedBase = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8'))
    return parsed.global?.baseWorkspace ?? null
  } catch {
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

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

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
  await page.evaluate(async () => {
    const token = new URL(location.href).searchParams.get('token') ?? ''
    await fetch(`${location.origin}/api/workspace/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'w', method: 'workspace/create',
        payload: { args: { request: { path: 'C:\\Users\\Think\\Desktop\\项目\\dsh-project-groups\\scripts' } } },
      }),
    })
  })
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

  console.log('')
  console.log('=== 点击「指定工作区」并逐帧采样 ===')
  await startSampling()
  const t0 = Date.now()
  await specifiedCard.click({ force: true })
  await page.waitForTimeout(4000)
  const specSamples = await readSamples()
  for (const sample of specSamples) {
    console.log(`  +${(sample.t - specSamples[0].t).toFixed(1)}ms  pressed=${sample.pressed}  selected=${String(sample.selectedClass)}  副标题=${JSON.stringify(sample.subtitle)}`)
  }
  console.log(`  磁盘: ${JSON.stringify(storedBase())}`)

  console.log('')
  console.log('=== 点击「默认工作区」并逐帧采样 ===')
  await startSampling()
  await defaultCard.click({ force: true })
  await page.waitForTimeout(4000)
  const defSamples = await readSamples()
  for (const sample of defSamples) {
    console.log(`  +${(sample.t - defSamples[0].t).toFixed(1)}ms  pressed=${sample.pressed}  selected=${String(sample.selectedClass)}  副标题=${JSON.stringify(sample.subtitle)}`)
  }
  console.log(`  磁盘: ${JSON.stringify(storedBase())}`)

  console.log('')
  console.log('=== 再次点击「指定工作区」（用户说的"切换回来闪烁"）===')
  await startSampling()
  await specifiedCard.click({ force: true })
  await page.waitForTimeout(4000)
  const backSamples = await readSamples()
  for (const sample of backSamples) {
    console.log(`  +${(sample.t - backSamples[0].t).toFixed(1)}ms  pressed=${sample.pressed}  selected=${String(sample.selectedClass)}  副标题=${JSON.stringify(sample.subtitle)}`)
  }
  console.log(`  磁盘: ${JSON.stringify(storedBase())}`)

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
  // Two clicks are needed: the sequence above ends on `specified`, so the first 默认 click
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
  const analysing = [
    ['切到指定', specSamples],
    ['切到默认', defSamples],
    ['切回指定', backSamples],
  ]
  for (const [label, samples] of analysing) {
    const flips = samples.length
    const intermediate = samples.filter((sample, index) => index > 0 && index < samples.length - 1)
    console.log(`  ${label}: ${String(flips)} 个状态变化${intermediate.length === 0 ? '（无中间态）' : `，含 ${String(intermediate.length)} 个中间态：`}`)
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
  for (const [label, samples] of analysing) {
    const labels = samples.map(sample => sample.subtitle)
    check(`${label}：副标题不出现「未选择」中间态`,
      !labels.includes('未选择'), JSON.stringify(labels))
  }
  // The selected card must never be "neither": exactly one card is pressed after settling.
  for (const [label, samples] of analysing) {
    const settled = samples[samples.length - 1]
    check(`${label}：稳定后恰好一张卡片被选中`,
      settled !== undefined && (settled.pressed === 'true/false' || settled.pressed === 'false/true'),
      String(settled?.pressed))
  }
  check('重复点已选中的卡片不产生写请求', idleWrites.length === 0, `${String(idleWrites.length)} 次`)
  // The memory must still be on disk after the whole sequence, and the toggle must have
  // actually moved: a probe that asserted "no flash" while nothing changed would pass
  // vacuously.
  check('整轮结束后磁盘仍带记忆',
    (storedBase()?.path ?? '') !== '' && storedBase()?.name === 'scripts',
    JSON.stringify(storedBase()))
  check('整轮结束后停在「默认」且记忆仍在',
    storedBase()?.mode === 'default' && storedBase()?.path !== undefined,
    JSON.stringify(storedBase()))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
