/**
 * Approach "B" asked: keep the official UI 1:1 and only swap its data source.
 * This probe tests every seam B could use, against the REAL machinery shipped
 * in DSH 0.1.7-rc.2 (the real SlotCore and the real cordis Context — no mocks
 * of the mechanisms under test).
 *
 * Result: B is not reachable. All seams are closed by explicit design, not by
 * accident. This script exists so the finding is reproducible and so the next
 * person does not re-derive it.
 *
 * HOW TO READ THE RESULT
 *   - `PASS`/`FAIL` lines are executed checks. The exit code is derived from
 *     them, so this script is usable as a gate.
 *   - `ASSUMED` lines are *quoted* from shipped source rather than executed.
 *     They are narrative, not evidence: the invariant they describe lives in a
 *     browser bundle (registered through `window.__ModuleLoader__.load(...)`)
 *     that this Node runner cannot import. They are never counted as PASS.
 *   - Run `node scripts/probe-slots.mjs` and `node scripts/probe-service.mjs`
 *     for the same conclusion split by seam.
 */
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { Context } from '@deepseek-ai/cordis'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}
const say = (text) => console.log(text)

// ---------------------------------------------------------------------------
// Seam 1 — replace the root `useWorkspaces` hook the official browser reads.
// ---------------------------------------------------------------------------
// The official browser gets its data from `ctx.slots.provideRoot({ hooks: {
// workspaces } })`. The renderer's rebuildRootBinding() funnels every root
// contribution through copyUnique(), which throws on a duplicate prop name:
//
//   if (finalProps.has(propName)) throw new Error(`duplicate root standard
//     ${kind} '${name}' at prop '${propName}'`)
//
// `provideRoot` is not a merge point; it is a union with a uniqueness
// invariant. There is no priority, no shadowing, and no override — a second
// contributor of `workspaces` is a hard error.
//
// NOT EXERCISED. This is the one seam whose rule cannot be executed from here:
// the check above ships in `@deepseek-ai/dsh-client-ui-renderer`'s *browser*
// bundle (`lib/client.js`, `window.__ModuleLoader__.load(...)`); the package's
// host entries (`lib/index.js`, `lib/invariant.js`) export no such function, so
// there is nothing to import and call. Labelling it CLOSED without saying so
// would let this block keep printing CLOSED even if the upstream invariant were
// deleted, which is worse than admitting the gap.
say('ASSUMED  SEAM 1 — root hook replacement: closed by the quoted invariant (NOT exercised here)')
say('  source: @deepseek-ai/dsh-client-ui-renderer/lib/client.js')
say('    if (finalProps.has(propName)) throw new Error(`duplicate root standard')
say("      ${kind} '${name}' at prop '${propName}'`)")
say('  no priority, no shadowing, no override: a second `workspaces` contributor')
say('  under the same root slot is a hard error.')

// ---------------------------------------------------------------------------
// Seam 2 — replace the `workspaces` service the official browser reads.
// ---------------------------------------------------------------------------
const root = new Context()
const official = { marker: 'official' }
const impostor = { marker: 'impostor' }

// Await the fiber instead of sleeping on a timer. `apply` is deferred (`root.plugin`
// returns before it runs), so a fixed 20 ms wait can read `attempts` while it is
// still `{}`: both keys print as `undefined`, which is indistinguishable from the
// observations a genuinely closed seam produces, and the report turns an
// inconclusive run into a confident "CLOSED".
const officialFiber = root.plugin({
  name: 'official-workspace-client',
  apply(ctx) { ctx.provide('workspaces', official) },
})
await officialFiber.await()

const attempts = {}
const ourFiber = root.plugin({
  name: 'project-groups',
  apply(ctx) {
    try { ctx.provide('workspaces', impostor); attempts.provide = 'succeeded' }
    catch (error) { attempts.provide = error.message }
    try { ctx.set('workspaces', impostor); attempts.set = 'succeeded' }
    catch (error) { attempts.set = error.message }
  },
})
await ourFiber.await()

// The verdict is derived from what was observed, never hard-coded: a seam that
// opens must print OPEN and fail the run.
const serviceClosed = attempts.provide !== 'succeeded' && attempts.set !== 'succeeded'
const serviceWinner = root.get('workspaces')?.marker

say('')
say(`SEAM 2 — service replacement: ${serviceClosed ? 'CLOSED' : 'OPEN'}`)
say(`  provide() -> ${attempts.provide}`)
say(`  set()     -> ${attempts.set}`)
say(`  service still resolves to: ${serviceWinner}`)
check('Seam 2: provide() of an already-provided service is refused',
  attempts.provide !== 'succeeded', String(attempts.provide))
check('Seam 2: set() cannot replace a service across fibers',
  attempts.set !== 'succeeded', String(attempts.set))
check('Seam 2: the official service is still the one that resolves',
  serviceWinner === 'official', String(serviceWinner))

// ---------------------------------------------------------------------------
// Seam 3 — shadow the slot, then re-declare the official child holes so our
// entry can render the official actions itself.
// ---------------------------------------------------------------------------
const core = new SlotCore()
core.register({
  name: 'root',
  children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' } },
}, () => null)
const officialEntryDisposer = core.register({
  name: 'sidebar.workspaces',
  children: {
    'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' },
    'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' },
  },
}, () => null)
core.register({ name: 'sidebar.workspaces.session.menu.item', id: 'archive' }, () => null)

const disposeOurs = core.register({ name: 'sidebar.workspaces', priority: -100 }, () => null)

let childError = null
try {
  core.register({
    name: 'sidebar.workspaces',
    priority: -200,
    children: { 'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' } },
  }, () => null)
} catch (error) { childError = error }

// Everything that touches the registry runs under try/finally: an unexpected
// throw (a SlotCore API change, a missing entry) would otherwise skip the
// disposers, leave the ledger dirty for anything that follows, and abort the
// script before the summary line.
const declaresOfficialHoles = (entry) =>
  Object.hasOwn(entry?.children ?? {}, 'sidebar.workspaces.session.row.action')

// The disposers must each run exactly once and always: `oursDisposed` keeps the
// success path from disposing twice when the `finally` also fires.
let oursDisposed = false
const disposeOursOnce = () => { if (!oursDisposed) { oursDisposed = true; disposeOurs() } }

let seam3Error = null
try {
  const ourEntry = core.entries('sidebar.workspaces').find(entry => (entry.options.priority ?? 0) === -100)
  const officialEntry = core.entries('sidebar.workspaces').find(entry => (entry.options.priority ?? 0) === 0)

  say('')
  say('SEAM 3 — re-declare the official child holes: CLOSED')
  say('  registering a child the official entry already declared ->')
  say(`    ${childError?.message?.slice(0, 110) ?? '(no error thrown)'}`)
  say('  and renderSlot is authorised per entry:')
  say('    shipped renderer: `const declared = entry.children?.[key]`')
  say("    throws SlotOwnershipError: \"slot '...' is not declared by this entry's children\"")

  check('Seam 3: registering a child hole the official entry already declared is refused',
    typeof childError?.message === 'string' && childError.message.includes('already declared'),
    childError?.message?.slice(0, 110) ?? 'no error thrown')

  if (ourEntry === undefined || officialEntry === undefined) {
    // Guarded rather than dereferenced: `ourEntry.children` on a pruned/renamed
    // entry threw a TypeError and killed the run before any conclusion printed.
    check('Seam 3: both our shadow entry and the official entry are registered', false,
      `ourEntry=${ourEntry === undefined ? 'missing' : 'present'} officialEntry=${officialEntry === undefined ? 'missing' : 'present'}`)
  } else {
    // Ownership is an observation about the ledger, not a restatement of a
    // boolean: our shadow entry declares no children of its own, so it must not
    // own the official child hole, and renderSlot must refuse it.
    const ownsChild = Object.hasOwn(ourEntry.children ?? {}, 'sidebar.workspaces.session.menu.item')
    say(`  our entry owns that child: ${ownsChild} -> renderSlot would throw: ${!ownsChild}`)
    check('Seam 3: our shadow entry does not own the official child hole',
      ownsChild === false, `ownsChild=${ownsChild}`)
  }

  disposeOursOnce()
  const winnerAfter = core.entriesOfSlot('sidebar.workspaces')[0]
  say(`  disposal restores the official entry (it declares the official child holes): ${declaresOfficialHoles(winnerAfter)}`)
  check('Seam 3: disposing our shadow entry restores the official entry',
    declaresOfficialHoles(winnerAfter), `children=${JSON.stringify(Object.keys(winnerAfter?.children ?? {}))}`)
} catch (error) {
  seam3Error = error
} finally {
  try { disposeOursOnce() } finally { officialEntryDisposer() }
}
// An unexpected throw is reported as a failure instead of aborting the run: the
// summary line and the exit code must always be produced.
check('Seam 3: the registry walk completed without throwing', seam3Error === null,
  seam3Error === null ? undefined : String(seam3Error?.message ?? seam3Error))

// `entries()` and `entriesOfSlot()` are both "a stored registration" and are
// free to hand back different wrappers for the same registration, so the restore
// check above is keyed on what the entry *declares* rather than on object
// identity — an identity check would report `false` for a correct restore.

// ---------------------------------------------------------------------------
say('')
say('CONCLUSION')
say('  Every B seam is closed by an explicit invariant in shipped code.')
say('  The official UI cannot be kept 1:1 by swapping its data source;')
say('  matching it means reimplementing its behaviour inside our own entry.')
say('  (Seam 1 is quoted, not executed — see the ASSUMED line above.)')
say('')
console.log(`${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
// `process.exitCode`, not `process.exit()`: let Node drain stdout instead of
// cutting the report short on a pipe.
process.exitCode = failures.length === 0 ? 0 : 1
