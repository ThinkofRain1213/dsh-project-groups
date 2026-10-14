/**
 * When is a service provided by THIS fiber readable from THIS fiber?
 *
 * The vendored browser would read `projectGrouping` lazily (inside the slot
 * inject factory, which runs after apply). Four shapes are under test:
 *   A. read synchronously inside apply, right after provide  -> (seen: undefined)
 *   B. read after the fiber is ready, from the same ctx
 *   C. read from a nested child fiber
 *   D. read by a DIFFERENT plugin's fiber
 *
 * "After the fiber is ready" is not a delay to be guessed. `root.plugin(...)`
 * returns the plugin's fiber, which is a thenable that settles once `apply` has
 * returned *and* the fiber is ready; that is the only boundary that separates
 * "not visible yet because the fiber is mid-apply" from "not visible by rule".
 * The previous version read B/C/D from bare `setTimeout` callbacks, so a null
 * result could just as well have meant "the timer fired before the fiber was
 * ready" — which is exactly the distinction this probe exists to settle.
 *
 * The post-ready reads poll for the service instead of sleeping a magic number
 * of milliseconds, because the old per-key delays (30/40/50 ms) encoded an
 * assumed scheduling order: on a loaded machine they could fire before the fiber
 * was ready, which is indistinguishable in the report from a service that is not
 * visible by rule.
 *
 * Every read is wrapped: a `ctx.get` that throws would otherwise become an
 * unhandled exception and the key would just vanish from the report, which
 * reads as "not visible" rather than "errored".
 */
import { Context } from '@deepseek-ai/cordis'

/** Bounded poll, used only where single-threaded ordering is not enough. */
const READY_POLL_TIMEOUT_MS = 2000
const READY_POLL_INTERVAL_MS = 5

/**
 * What a post-ready read must observe. Named so the expectation is stated once
 * and the assertions below cannot drift from the report line.
 */
const VISIBLE = 'observable'

const observable = { marker: 'grouping' }
const root = new Context()
const seen = {}

const later = []
/** Read `key` off `ctx` once `ctx.get` reports it, then record it. */
async function readWhenReady(label, ctx, key) {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    let value
    try {
      value = ctx.get(key)
    } catch (error) {
      // Recorded, not thrown: an earlier version let this escape, which dropped
      // the key from the report entirely and read as "not visible".
      seen[label] = `THREW: ${error.message}`
      return
    }
    if (value !== undefined) { seen[label] = value; return }
    await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS))
  }
  seen[label] = `TIMEOUT waiting for ${key}`
}

/** Queue a post-ready read. Nothing polls it until every fiber has settled. */
const record = (label, ctx, key) => {
  later.push(readWhenReady(label, ctx, key))
}

const entryFiber = root.plugin({
  name: 'our-entry',
  apply(ctx) {
    ctx.provide('projectGrouping', observable)
    // A: deliberately synchronous — this is the shape that fails.
    try {
      seen.A_immediately = ctx.get('projectGrouping')
    } catch (error) {
      seen.A_immediately = `THREW: ${error.message}`
    }

    // B: after this apply unwinds and this fiber is ready, read again from the
    // very same ctx. This is the read the vendored browser's lazy factory makes.
    record('B_afterReady', ctx, 'projectGrouping')

    // C: nested child fiber, read synchronously inside its own apply and then
    // once the parent fiber is ready.
    ctx.plugin({
      name: 'child',
      apply(childCtx) {
        try {
          seen.C_childSync = childCtx.get('projectGrouping')
        } catch (error) {
          seen.C_childSync = `THREW: ${error.message}`
        }
        record('C_childLater', childCtx, 'projectGrouping')
      },
    })
  },
})

// D: a separate sibling plugin, read synchronously and then post-ready.
const siblingFiber = root.plugin({
  name: 'sibling',
  apply(ctx) {
    try {
      seen.D_siblingSync = ctx.get('projectGrouping')
    } catch (error) {
      seen.D_siblingSync = `THREW: ${error.message}`
    }
    record('D_siblingLater', ctx, 'projectGrouping')
  },
})

// The readiness boundary the whole probe depends on: awaiting these fibers is
// what makes B/C/D post-apply reads rather than guesses at a timer value.
//
// Guarded, because a fiber whose `apply` threw rejects on await — letting that
// escape would kill the probe before the report and the exit code, which is the
// failure mode this file exists to avoid.
try {
  await Promise.all([entryFiber, siblingFiber])
  await Promise.all(later)
} catch (error) {
  console.log(`FAIL  a fiber failed to become ready — ${error.message}`)
  seen.fiber = `THREW: ${error.message}`
}

for (const [k, v] of Object.entries(seen)) {
  console.log(`${k.padEnd(18)} = ${v === observable ? `${VISIBLE} ✓` : String(v)}`)
}
console.log('root.get          =', root.get('projectGrouping') === observable ? `${VISIBLE} ✓` : root.get('projectGrouping'))

// The probe used to only print, so a regression in visibility read as output
// rather than as a failing run and CI could not notice it. The two reads that
// are asserted are the ones the design depends on: a read after readiness, from
// the fiber's own ctx and from a sibling's ctx, must see the service.
const failures = []
const expectVisible = (label) => {
  const ok = seen[label] === observable
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} sees the service after readiness${ok ? '' : ` — got ${String(seen[label])}`}`)
  if (!ok) failures.push(label)
}
expectVisible('B_afterReady')
expectVisible('D_siblingLater')
expectVisible('C_childLater')

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exitCode = failures.length === 0 ? 0 : 1
