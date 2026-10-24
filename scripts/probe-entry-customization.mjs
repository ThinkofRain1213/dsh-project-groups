/**
 * Does rc.3's `ui-entry-customization` menu item actually open a Session with its prompt?
 *
 * This is the end-to-end acceptance for the `startSession` two-argument fix. Upstream
 * rc.3 added `ui-entry-customization`, which lives in the web-app bundle and calls
 *
 *     uiWorkspace.startSession(undefined, { agentPreset: 'cordis', prompt, whenDraftExists: 'append' })
 *
 * The second parameter is an OPTIONS OBJECT upstream but was a `beforeOpen` callback in
 * this fork, so before the fix the object landed where a function was expected and
 * `beforeOpen?.(sessionId)` threw **after** the Session had been created. The user saw
 * an empty Session with no prompt and no notice — and because the throw happens inside
 * a `void promise.catch(console.warn)`, nothing surfaced in the UI at all.
 *
 * What this probes, in order:
 *   1. the menu item exists and is reachable;
 *   2. clicking it opens a Session (the part that always worked);
 *   3. **the draft contains the prompt** (the part the fix restores);
 *   4. no `place is not a function` / `beforeOpen is not a function` reached the console.
 *
 * Usage: node probe-entry-customization.mjs <dshExe> <asarRoot> <dshHome>
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { redactToken } from './lib/redact.mjs'
import { dismissModals as dismissShared, ensureProbeProfile, settleOnboarding } from './lib/boot-dsh.mjs'

const [exe, asarRoot, dshHome] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-entry-customization.mjs <dshExe> <asarRoot> <dshHome>')
  process.exit(2)
}

const PORT = Number(process.env.DSH_PROBE_PORT ?? 17661)
const PROFILE = process.env.DSH_PROBE_PROFILE ?? 'pg'
const BIN = join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** The menu row rc.3 adds. Localized copy, so a wording change breaks this one line. */
const CREATE_LABEL = '创建你的插件'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const consoleLines = []
let browser
let page
let server

const start = () => new Promise((resolve, reject) => {
  const child = spawn(exe, [BIN, '--profile', PROFILE, '--port', String(PORT), '--no-open'], {
    env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  const timer = setTimeout(() => { child.kill(); reject(new Error(`boot timeout: ${redactToken(out.slice(-400))}`)) }, 120_000)
  child.on('error', (error) => { clearTimeout(timer); reject(error) })
  child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}`)) })
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve({ child, url: m[1] }), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += String(chunk) })
})

try {
  const prepared = await ensureProbeProfile({ exe, asarRoot, dshHome, profile: PROFILE })
  if (prepared.problem !== undefined) { console.error(`无法准备探针环境：${prepared.problem}`); process.exit(2) }

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  page.on('console', (message) => { if (message.type() === 'error') consoleLines.push(message.text()) })
  page.on('pageerror', (error) => { consoleLines.push(`pageerror: ${error.message}`) })

  server = await start()
  await page.goto(server.url, { waitUntil: 'networkidle', timeout: 60_000 })
  const onboarded = await settleOnboarding(page)
  if (onboarded.masked) console.log('  ⚠ 仍有遮罩')

  // --- 1. the row exists ---------------------------------------------------------
  // It registers into three slots; the sidebar panel list's "more" menu is the one
  // reachable without an open conversation.
  const moreButtons = page.locator('button[aria-label], button').filter({ hasText: /更多|More/ })
  const moreCount = await moreButtons.count()
  console.log(`  「更多」按钮数: ${moreCount}`)
  let opened = false
  for (let i = 0; i < moreCount && !opened; i += 1) {
    const candidate = moreButtons.nth(i)
    if (!await candidate.isVisible().catch(() => false)) continue
    await candidate.click({ force: true }).catch(() => {})
    await page.waitForTimeout(900)
    if (await page.getByText(CREATE_LABEL, { exact: false }).count() > 0) { opened = true; break }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  check(`rc.3 的「${CREATE_LABEL}」菜单项可达`, opened,
    opened ? 'found' : `payload=${await page.evaluate(() => document.body.innerText.slice(0, 120))}`)

  if (!opened) {
    // Without the row there is nothing to accept; say so rather than reporting green.
    console.log('  无法触发入口，跳过端到端部分')
  } else {
    // --- 2. clicking it lands on a Session -------------------------------------
    //
    // NOT "a new row appeared". Upstream reuses the blank Session when one is already
    // there (`connectBlank` → `createInWorkspace` names the first reusable blank), so a
    // fresh profile goes 1 -> 1. Counting rows would therefore fail on correct
    // behaviour. What has to change is the draft, which assertion 3 measures; here the
    // row count is only logged so a reader can see reuse actually happened.
    const before = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].length)
    await page.getByText(CREATE_LABEL, { exact: false }).first().click({ force: true })
    await page.waitForTimeout(6000)
    const after = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].length)
    console.log(`  会话行数: ${before} -> ${after}（复用空白会话属正常）`)

    // --- 3. the draft carries the prompt ---------------------------------------
    // The composer is a contenteditable; its text is the draft the prompt produced.
    const draftText = await page.evaluate(() => {
      const editor = document.querySelector('[contenteditable="true"]')
      return editor === null ? null : (editor.innerText ?? '').trim()
    })
    console.log(`  草稿内容: ${JSON.stringify(draftText?.slice(0, 80) ?? null)}`)
    check('草稿里有 entry-customization 的 prompt',
      typeof draftText === 'string' && draftText.includes('DSH 插件'),
      JSON.stringify(draftText?.slice(0, 60) ?? null))

    // --- 4. no TypeError reached the console -----------------------------------
    const offender = consoleLines.find(line => /is not a function/.test(line)
      && /beforeOpen|place/.test(line))
    check('控制台没有 startSession 的 TypeError', offender === undefined, offender ?? '(clean)')
  }

  console.log('')
  console.log(`console errors: ${consoleLines.length === 0 ? '(none)' : JSON.stringify(consoleLines.slice(0, 3))}`)
} finally {
  if (server?.child !== undefined && server.child.exitCode === null) server.child.kill()
  if (browser !== undefined) await browser.close()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
