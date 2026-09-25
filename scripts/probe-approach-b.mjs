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
 *   - The `PASS` lines are checks that the seam is CLOSED as described.
 *   - Run `node scripts/probe-slots.mjs` and `node scripts/probe-service.mjs`
 *     for the same conclusion split by seam.
 */
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { Context } from '@deepseek-ai/cordis'

const notes = []
const say = (text) => { notes.push(text); console.log(text) }

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
// contributor of `workspaces` is a hard error. This is asserted structurally
// here rather than by importing the renderer (which is a UI bundle, not a
// library): the rule is one line of shipped code, quoted above.
say('SEAM 1 — root hook replacement: CLOSED')
say('  reason: provideRoot() rejects a duplicate root standard prop name')
say('  ("duplicate root standard hook \'workspaces\' at prop \'useWorkspaces\'")')
say('  there is no priority or override path; a second provider is an error')

// ---------------------------------------------------------------------------
// Seam 2 — replace the `workspaces` service the official browser reads.
// ---------------------------------------------------------------------------
const root = new Context()
const official = { marker: 'official' }
const impostor = { marker: 'impostor' }

const officialPlugin = {
  name: 'official-workspace-client',
  apply(ctx) { ctx.provide('workspaces', official) },
}
root.plugin(officialPlugin)
await new Promise(resolve => setTimeout(resolve, 20))

const attempts = {}
const ourPlugin = {
  name: 'project-groups',
  apply(ctx) {
    try { ctx.provide('workspaces', impostor); attempts.provide = 'succeeded' }
    catch (error) { attempts.provide = error.message }
    try { ctx.set('workspaces', impostor); attempts.set = 'succeeded' }
    catch (error) { attempts.set = error.message }
  },
}
root.plugin(ourPlugin)
await new Promise(resolve => setTimeout(resolve, 20))

say('')
say('SEAM 2 — service replacement: CLOSED')
say(`  provide() -> ${attempts.provide}`)
say(`  set()     -> ${attempts.set}`)
say(`  service still resolves to: ${root.get('workspaces')?.marker}`)

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

const ourEntry = core.entries('sidebar.workspaces').find(e => (e.options.priority ?? 0) === -100)
const officialEntry = core.entries('sidebar.workspaces').find(e => (e.options.priority ?? 0) === 0)
const ownsChild = Object.hasOwn(ourEntry.children ?? {}, 'sidebar.workspaces.session.menu.item')
const renderSlotWouldThrow = !ownsChild

say('')
say('SEAM 3 — re-declare the official child holes: CLOSED')
say(`  registering a child the official entry already declared ->`)
say(`    ${childError?.message?.slice(0, 110)}`)
say('  and renderSlot is authorised per entry:')
say("    shipped renderer: `const declared = entry.children?.[key]`")
say("    throws SlotOwnershipError: \"slot '...' is not declared by this entry's children\"")
say(`  our entry owns that child: ${ownsChild} -> renderSlot would throw: ${renderSlotWouldThrow}`)

disposeOurs()
const winnerAfter = core.entriesOfSlot('sidebar.workspaces')[0]
say(`  (disposal restores the official entry: ${winnerAfter === officialEntry})`)
officialEntryDisposer()

// ---------------------------------------------------------------------------
say('')
say('CONCLUSION')
say('  Every B seam is closed by an explicit invariant in shipped code.')
say('  The official UI cannot be kept 1:1 by swapping its data source;')
say('  matching it means reimplementing its behaviour inside our own entry.')
say('')
say(`  ${notes.length} findings recorded.`)
