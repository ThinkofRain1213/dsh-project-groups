/**
 * Prove the flash-and-revert mechanism, and that the failure is silent.
 *
 * Timeline evidence says the user's host process is stale (started 08:08, while steps ①
 * and ② were written at 11:03 and 11:50), so its `setBaseWorkspace` does not exist while
 * the browser loads the new client bundle from disk on every page load. This reproduces
 * that pairing deterministically by failing only that one endpoint, which is exactly what a
 * host without the method does — without having to swap bundles or restart anything.
 *
 * Expected mechanism, asserted here:
 *   1. `ProjectModel.setBaseWorkspace` writes optimistically, so the card **paints 指定**
 *      (the flash);
 *   2. the RPC fails, so the catch reverts, and because nothing superseded the value the
 *      revert lands — the card **snaps back to 默认**;
 *   3. the revert clears `path`, so the next click on 指定 takes the "no path yet" branch
 *      and **reopens the chooser** — the loop the user described.
 *
 * It also logs what the user was told: if nothing visible appears, the revert is silent,
 * which is a real defect independent of the stale host (a rejected write must not look
 * like a mysterious flicker).
 *
 * Usage: node probe-base-workspace-write-rejected.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactToken } from './lib/redact.mjs'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-write-rejected.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
// Overridable: a leftover Host from an aborted run holds the fixed port, and the next probe
// then reports a boot timeout for what is really an occupied port.
const PORT = Number(process.env.DSH_PROBE_PORT ?? (profile === 'pg' ? 17930 : 17931))
// `join`, not a `\\`-joined literal: on a POSIX runner a backslash is an ordinary filename
// character, so the literal path silently never resolves.
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/**
 * The checkout this probe's fixture Workspaces point at.
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

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

let child
let browser
let page

/**
 * The stub's answer to one `setBaseWorkspace` request.
 *
 * `rpcId` is echoed back from the intercepted request rather than hardcoded: the client resolves
 * its pending call by `rpcId`, so a response carrying an id it never sent is discarded and the
 * failure branch this probe exists to observe would never run — while checks 1–4 below still
 * looked like measurements of it.
 * @param request - the intercepted Playwright request.
 * @returns the response body to fulfil with.
 */
const stubBody = (request) => {
  let rpcId = 'stubbed'
  try {
    const sent = JSON.parse(request.postData() ?? '{}')
    if (typeof sent.rpcId === 'string') rpcId = sent.rpcId
  } catch {
    // A body that is not JSON cannot be correlated anyway; the literal keeps the response valid.
  }
  return JSON.stringify({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code: 'not-found', message: 'method not found' } },
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
        await button.click({ force: true }).catch((error) => {
          console.log(`  dismiss: click on "${label}" failed — ${error.message}`)
        })
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(700)
  }
  if (await isMasked()) console.log('  dismiss: a modal mask is STILL up after 8 rounds — later checks may be measuring an intercepted UI')
}

const card = () => page.locator('[data-plugin-config]').first()
const pressed = async () => {
  const cubes = card().locator('button[aria-pressed]')
  if (await cubes.count() !== 2) return null
  const states = await cubes.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-pressed')))
  return { default: states[0], specified: states[1] }
}
const storedBase = () => {
  const file = join(dshHome, 'storages', 'project_groups.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed.global?.baseWorkspace ?? null
  } catch {
    // Silent before: a corrupt file and "no setting stored" both read as `null`, so a storage
    // failure surfaced only as a confusing check failure.
    if (existsSync(file)) console.log(`  storedBase: ${file} could not be read/parsed`)
    return null
  }
}

try {
  // Spawned inside the `try` so the `finally` always reaches `child.kill()`. While this sat above
  // the `try`, a boot timeout — or any throw out of `chromium.launch` — rejected the top-level
  // await before cleanup ran and left the Host running on the port.
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
  const context = await browser.newContext()
  // Fail ONLY the step-② write, the way a host without that method behaves. Everything
  // else — including `baseline`, which is what paints the row — still works.
  //
  // Stubbed at the **route** layer rather than by replacing `window.fetch`: the client
  // wraps fetch during boot, so an init-script wrapper is bypassed (measured — the write
  // landed and the stub never ran). `route` intercepts whatever transport the app uses.
  let stubbedCalls = 0
  await context.route('**/api/projectGroups/setBaseWorkspace', async (route) => {
    stubbedCalls += 1
    // Delayed on purpose: the optimistic paint and the revert are otherwise inside one
    // round trip, and a fast local failure can complete before the first sample. A slow
    // host is the realistic case this reproduces (a cold process answering after boot).
    await new Promise(resolve => setTimeout(resolve, 700))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: stubBody(route.request()),
    })
  })
  page = await context.newPage()
  page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))
  const warnings = []
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text())
  })

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  // The response is read and asserted.
  //
  // It used to be discarded, so a failed seed `workspace/create` (wrong token, 4xx/5xx) was
  // silent and the sections below then measured the wrong state — reporting a product failure for
  // what was really a broken setup.
  // The fixture path is passed **into** the page rather than built there: `join` is a Node
  // import and does not exist in the browser, so `join(repoRoot, 'scripts')` inside this
  // `evaluate` threw a ReferenceError and the seed never ran.
  const seeded = await page.evaluate(async (fixturePath) => {
    const token = new URL(location.href).searchParams.get('token') ?? ''
    const response = await fetch(`${location.origin}/api/workspace/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-token': token },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'w', method: 'workspace/create',
        payload: { args: { request: { path: fixturePath } } },
      }),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* reported through status */ }
    return { status: response.status, ok: parsed?.result?.ok, error: parsed?.result?.error, text: text.slice(0, 200) }
  }, join(repoRoot, 'scripts'))
  check('前置：种子 workspace/create 成功', seeded.status === 200 && seeded.ok !== false,
    `status=${String(seeded.status)} ok=${String(seeded.ok)} error=${JSON.stringify(seeded.error)}`)
  if (seeded.status !== 200 || seeded.ok === false) {
    throw new Error('the seed workspace/create failed; the sections below would measure the wrong state')
  }

  await dismiss()
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  await page.locator('text=dsh-project-groups').first().click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()

  console.log(`初始: ${JSON.stringify(await pressed())}  disk=${JSON.stringify(storedBase())}`)

  console.log('')
  console.log('=== 手势：点「指定工作区」→ 选一行 → 确认（写入会被拒绝）===')
  const specifiedCard = card().locator('button[aria-pressed]').filter({ hasText: '指定工作区' }).first()
  await specifiedCard.click({ force: true })
  await page.waitForTimeout(1500)
  const chooser = page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
  await chooser.locator('[role="option"]').first().click({ force: true })
  await page.waitForTimeout(500)
  await chooser.getByRole('button', { name: '确认' }).first().click({ force: true })

  // Sample fast enough to catch the optimistic paint before the revert.
  console.log('')
  console.log('=== 每 50ms 采样 3s（捕捉"闪一下"）===')
  const trace = []
  // Elapsed wall time, not the nominal `i * 0.05`: every iteration also awaits an `evaluate`
  // round trip, so the printed `t=` drifted from the real timing while the output is presented
  // as timing evidence for the flash.
  const startedAt = Date.now()
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(50)
    const state = await pressed()
    const key = state === null ? '?' : `${state.default}/${state.specified}`
    if (trace.length === 0 || trace[trace.length - 1].key !== key) {
      const t = ((Date.now() - startedAt) / 1000).toFixed(2)
      trace.push({ t, key })
      console.log(`  t=${t}s  默认=${String(state?.default)} 指定=${String(state?.specified)}`)
    }
  }

  const sawSpecified = trace.some(step => step.key === 'false/true')
  const endedDefault = trace[trace.length - 1]?.key === 'true/false'
  console.log('')
  check('0) 桩确实拦到了写请求', stubbedCalls > 0, `拦截 ${String(stubbedCalls)} 次`)
  check('1) 先闪到「指定」（乐观写入生效）', sawSpecified, JSON.stringify(trace.map(t => `${t.t}s:${t.key}`)))
  check('2) 随后跳回「默认」（失败回滚）', endedDefault, `最终 ${String(trace[trace.length - 1]?.key)}`)
  check('3) 磁盘上没有写入（host 从未接受）', storedBase() === null, JSON.stringify(storedBase()))

  console.log('')
  console.log('=== 4. 再点「指定工作区」：又是弹窗（用户说的循环）===')
  await specifiedCard.click({ force: true })
  await page.waitForTimeout(1500)
  const reopened = await chooser.count()
  check('4) 又是弹窗而不是直接选中', reopened === 1, `chooser=${String(reopened)}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  console.log('')
  console.log('=== 5. 用户看到了什么解释 ===')
  const visibleAlerts = await page.locator('[role="alert"], [role="note"]').allInnerTexts().catch(() => [])
  console.log(`  页面上的 alert/note: ${JSON.stringify(visibleAlerts)}`)
  console.log(`  console 警告: ${JSON.stringify(warnings.slice(0, 4))}`)
  // Keyed to *this* write, not to "some alert exists". The old form passed on any non-empty
  // `[role="alert"]`/`[role="note"]` on the page and on any warning matching /reject|失败|fail/i,
  // so an unrelated row note made it green; and a real message that did not happen to use those
  // words made it red. The console side has an exact label to match — `optimistic()` is the only
  // reporter a rejected settings write has (`src/client/index.ts`: `set base workspace rejected:`)
  // — and the page side is required to at least name a workspace.
  const consoleReason = warnings.filter(w => w.includes('set base workspace rejected'))
  const visibleReason = visibleAlerts.filter(text => text.trim() !== '' && /底层工作区|指定工作区|工作区/.test(text))
  check('5) 写失败**没有**被静默吞掉（有这次写入自己的原因）',
    consoleReason.length > 0 || visibleReason.length > 0,
    `console=${JSON.stringify(consoleReason.slice(0, 2))} alerts=${JSON.stringify(visibleReason)}`)

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  if (child !== undefined) child.kill() // guarded: a synchronous `spawn` throw leaves it unset
  if (browser !== undefined) await browser.close() // guarded: the launch is inside the try now
}
process.exit(failures.length === 0 ? 0 : 1)
