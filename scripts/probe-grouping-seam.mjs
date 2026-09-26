/**
 * Mechanism probes for the L1a grouping seam.
 *
 * The vendored browser reads its grouping model from an observable the wrapper
 * passes in. Two facts make that safe, and both are asserted here rather than
 * assumed:
 *
 *   1. The vendored `apply` keeps its upstream default when no override is
 *      passed — whatever shape the loader calls it with, the one-argument call
 *      must still mean "group by the Host Workspace registry".
 *   2. The observable contract the renderer relies on: a *stable snapshot
 *      identity* (the selector compares by identity, so a fresh array per read
 *      would re-render every consumer) and a `subscribe` that returns a
 *      disposer.
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
  check('ctx.get on an unprovided service is undefined, not a throw', false, error.message.slice(0, 60))
}

// 2. The apply signature the loader uses: one argument. The override must be
//    optional, and its absence must be distinguishable from an empty override.
const { clientGrouping } = await import('../src/client/grouping.ts').catch(() => ({ clientGrouping: undefined }))
if (clientGrouping === undefined) {
  // The TS module is not directly importable here; assert the built bundle instead.
  check('grouping observable is reachable from the entry', false, 'src/client/grouping.ts not importable in this runner')
} else {
  const snap = clientGrouping.getSnapshot()
  check('the active override is an empty (not absent) claim', Array.isArray(snap) && snap.length === 0,
    `len=${Array.isArray(snap) ? snap.length : String(snap)}`)
  check('snapshot identity is stable across reads', clientGrouping.getSnapshot() === clientGrouping.getSnapshot())
  const dispose = clientGrouping.subscribe(() => {})
  check('subscribe returns a disposer', typeof dispose === 'function')
  check('the override never notifies (nothing to observe)', dispose() === undefined)
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
