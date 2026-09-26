/**
 * Capture the browser console and the real mount failure.
 *
 * The Host answers `projectGroups/baseline` over `/api`, and the contribution
 * passes every validation rule the Gateway applies. So the reason `$mount` fails
 * exists only inside the browser, where `ctx.remote` and the typert registry are
 * real. This drives the running Web UI with Playwright and prints exactly what
 * the page logged.
 *
 * Usage: node scripts/probe-browser-console.mjs <baseUrlWithToken>
 */
import { chromium } from 'playwright-core'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node probe-browser-console.mjs "http://127.0.0.1:PORT/?token=..."')
  process.exit(2)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const lines = []
page.on('console', (message) => { lines.push(`[${message.type()}] ${message.text()}`) })
page.on('pageerror', (error) => { lines.push(`[pageerror] ${error.message}`) })
page.on('requestfailed', (request) => {
  lines.push(`[requestfailed] ${request.method()} ${request.url()} — ${request.failure()?.errorText ?? ''}`)
})

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
// Give the client plugins, the mount, and the sidebar time to settle.
await page.waitForTimeout(8000)

console.log('=== page console ===')
for (const line of lines) console.log(line)

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

// The sidebar's project dialog reaching "namespace is not available" means the
// model never installed. Click it and read what happens.
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400))
console.log('\n=== visible text (head) ===')
console.log(bodyText)

await browser.close()
