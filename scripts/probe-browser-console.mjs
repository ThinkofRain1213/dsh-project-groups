/**
 * Capture the browser console and the real mount failure.
 *
 * The Host answers `projectGroups/baseline` over `/api`, and the contribution
 * passes every validation rule the Gateway applies. So the reason `$mount` fails
 * exists only inside the browser, where `ctx.remote` and the typert registry are
 * real. This drives the running Web UI with Playwright and prints exactly what
 * the page logged.
 *
 * Usage: node scripts/probe-browser-console.mjs <baseUrlWithToken> [settleMs]
 */
import { chromium } from 'playwright-core'
import { redactToken } from './lib/redact.mjs'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node probe-browser-console.mjs "http://127.0.0.1:PORT/?token=..." [settleMs]')
  process.exit(2)
}
// A page that throws on every frame can produce events far faster than they are read.
// The cap keeps the buffer (and the log) finite; only the tail is dropped, because the
// first events explain a mount failure and the rest repeat it.
const MAX_EVENTS = 400

const lines = []
const record = (line) => {
  if (lines.length < MAX_EVENTS) lines.push(line)
  else if (lines.length === MAX_EVENTS) lines.push(`… (capped at ${MAX_EVENTS} events)`)
}
let consoleFlushed = false
/** Print what the page logged. Called from the failure path too: this dump *is* the probe. */
const flushConsole = () => {
  if (consoleFlushed) return
  consoleFlushed = true
  console.log('=== page console ===')
  for (const line of lines) console.log(line)
}

let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('console', (message) => { record(`[${message.type()}] ${message.text()}`) })
  page.on('pageerror', (error) => { record(`[pageerror] ${error.message}`) })
  page.on('requestfailed', (request) => {
    // Redacted: the dev-server URL carries `?token=...`, and this fires exactly when
    // a request is failing — i.e. on the runs whose output someone reads and pastes.
    record(`[requestfailed] ${request.method()} ${redactToken(request.url())} — ${request.failure()?.errorText ?? ''}`)
  })

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  // `networkidle` only says the network went quiet, not that the client bundles mounted.
  // Wait for the shell's own boot global first — bounded and non-fatal, because a shell
  // that never defines it is itself worth printing — and then for a configurable settle
  // (`DSH_PROBE_SETTLE_MS`, or the optional second argument; default 8 s).
  //
  // A deterministic "the plugin is mounted" condition cannot be used here on purpose:
  // this probe exists to capture the console of a *failed* mount, so waiting on the
  // plugin's own affordance would time out and throw on exactly the runs it is for.
  await page.waitForFunction(() => typeof window.__DSH_BOOT__ !== 'undefined', null, { timeout: 30_000 })
    .catch(() => { console.log('(the shell never defined window.__DSH_BOOT__)') })
  await page.waitForTimeout(Number(process.argv[3] ?? process.env.DSH_PROBE_SETTLE_MS ?? 8000))

  flushConsole()

  // Ask the page what it knows: the namespace service, and the model.
  const answer = await page.evaluate(() => {
    const out = {}
    try {
      // The module loader keeps every registered bundle factory.
      out.loaded = Object.keys(window.__ModuleLoader__?.registry ?? {}).length
    } catch (error) { out.loadedError = String(error) }
    try {
      out.hasBoot = typeof window.__DSH_BOOT__ !== 'undefined'
      out.bootKeys = out.hasBoot ? Object.keys(window.__DSH_BOOT__) : []
    } catch (error) { out.bootError = String(error) }
    return out
  })
  console.log('\n=== page state ===')
  console.log(JSON.stringify(answer, undefined, 2))

  // The sidebar's project dialog reaching "namespace is not available" means the model
  // never installed. There is no click here on purpose — driving the dialog would add a
  // second failure mode to a probe whose subject is what the page logged; the visible text
  // is printed so a reader can see which dialog state the page reached. Capped at 400
  // characters as a head: the console dump carries the diagnosable detail.
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400))
  console.log('\n=== visible text (head) ===')
  console.log(bodyText)
} finally {
  // Flush first: a navigation/evaluate failure above must not swallow the console capture,
  // which is the only thing this probe produces. Then release the browser unconditionally.
  flushConsole()
  if (browser !== undefined) await browser.close()
}
