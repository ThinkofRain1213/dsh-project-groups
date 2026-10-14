/**
 * Mechanism probes for the L1a grouping seam.
 *
 * The vendored browser reads its grouping model from an observable the wrapper
 * passes in. Two facts make that safe, and both are asserted here rather than
 * assumed:
 *
 *   1. The observable contract the renderer relies on: a *stable snapshot
 *      identity* (the selector compares by identity, so a fresh array per read
 *      would re-render every consumer) and a `subscribe` that returns a
 *      disposer.
 *   2. The `projectGrouping` service name resolves when it is provided, so the
 *      `undefined` read of an unprovided service below means "absent" and not
 *      "the name is a typo".
 *
 * The loader's one-argument call — no override, so the region groups by the Host
 * Workspace registry exactly as upstream — is asserted where the derivation is
 * tested (`verify-grouping.mjs`), not here: reach it end to end would need a full
 * client context, and this file deliberately needs only cordis.
 *
 * It also records why the override is a parameter instead of a cordis service:
 * a service provided in the same `apply` is NOT readable from that fiber until
 * the apply unwinds (`probe-service-timing.mjs` measures the timing), so a
 * service-based read would race the slot declaration order.
 */
import { Context } from '@deepseek-ai/cordis'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// 1. An undeclared service must read as undefined, not throw: a composition
//    without this plugin must not break on a stray read.
const bare = new Context()
let stray
try {
  stray = bare.get('projectGrouping')
  check('ctx.get on an unprovided service is undefined, not a throw', stray === undefined)
} catch (error) {
  // A non-Error throw would make `error.message` itself throw here, replacing the
  // read failure with an unrelated TypeError and aborting the probe.
  check('ctx.get on an unprovided service is undefined, not a throw', false, String(error?.message ?? error).slice(0, 60))
}

// 1b. Positive control for the same name: `undefined` above is only evidence that the
//     service is absent if the name does resolve when something provides it. Without
//     this, a typo in the literal would read `undefined` too and the check above would
//     keep passing while asserting nothing.
const provider = new Context()
const controlValue = Object.freeze({ marker: 'provided' })
provider.plugin({ name: 'control-provider', apply(ctx) { ctx.provide('projectGrouping', controlValue) } })
await new Promise(resolve => setTimeout(resolve, 20))
check('the same service name resolves once it is provided', provider.get('projectGrouping') === controlValue)

// 2. The observable the browser reads: an array (empty included) is an active override.
let groupingModule
let groupingImportError
try {
  groupingModule = await import('../src/client/grouping.ts')
} catch (error) {
  // Previously every import failure collapsed into the same "not importable in this
  // runner" verdict, so a renamed export, a syntax error or a broken transitive import
  // inside the module was reported as a benign runner limitation and the probe still
  // printed PASS lines for the rest.
  groupingImportError = error
}
const clientGrouping = groupingModule?.clientGrouping
if (clientGrouping === undefined) {
  check('grouping observable is reachable from the entry', false,
    `src/client/grouping.ts yielded no clientGrouping: ${String(groupingImportError?.message ?? groupingImportError ?? 'no such export')}`)
} else {
  const snap = clientGrouping.getSnapshot()
  // `Array.isArray` is the contract: an array — empty included — is an active override,
  // while `undefined` would mean "group by the Host Workspace registry". The length is
  // recorded, not asserted: it belongs to the module's mutable default, so pinning it
  // would fail for reasons unrelated to this seam as soon as a real override is set.
  check('the pre-model snapshot is an active (array) override, never undefined', Array.isArray(snap),
    `len=${Array.isArray(snap) ? snap.length : String(snap)}`)
  check('snapshot identity is stable across reads', clientGrouping.getSnapshot() === clientGrouping.getSnapshot())
  const dispose = clientGrouping.subscribe(() => {})
  check('subscribe returns a disposer', typeof dispose === 'function')
  // No assertion on the disposer's *return value* — that is an implementation detail, not
  // part of the contract — and none on notification, since the callback is a no-op. What
  // a React unmount actually does is call the disposer (twice, under StrictMode), so that
  // is what is exercised: calling it must not throw.
  let disposeError
  try {
    dispose()
    dispose()
  } catch (error) {
    disposeError = error
  }
  check('the disposer is callable and safe to call twice', disposeError === undefined,
    String(disposeError?.message ?? disposeError ?? ''))
}

const summary = failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`
console.log(`\n${summary}`)
// `process.exitCode` rather than `process.exit()`: with stdout on a pipe (CI log capture)
// `console.log` is asynchronous, and an immediate exit truncated the very FAIL lines the
// run exists to print — exactly when the probe is failing.
process.exitCode = failures.length === 0 ? 0 : 1
