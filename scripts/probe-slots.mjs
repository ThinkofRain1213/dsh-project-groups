/**
 * Does the harness actually block approach "B" (keep the official UI, swap its
 * data source)? This exercises the real `@deepseek-ai/dsh-client-ui-slots`
 * SlotCore shipped with DSH 0.1.7-rc.2 — no mocks of the slot machinery.
 *
 * Two seams matter:
 *
 *   1. `register` refuses to declare a child slot that another entry already
 *      declared. The official browser declares the session menu / row-action
 *      holes as its children, and shadowing does not release them (only a
 *      dispose does) — so a replacement entry cannot re-declare them and
 *      therefore cannot render the official actions itself.
 *
 *   2. A `single` slot's lower-priority entry wins but leaves the loser on the
 *      ledger, so both entries coexist.
 */
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const core = new SlotCore()

// The sidebar shell declares the browsing region as a child of root (this is
// exactly what `@deepseek-ai/dsh-client-ui-sidebar` does), then ui-workspace
// claims it and declares its own child holes.
core.register({
  name: 'root',
  children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' } },
}, () => null)
// The returned disposer is deliberately not kept: this registration stands in for the
// shipped sidebar for the whole first section, and every later check reads the ledger
// expecting it there. Only OUR entry is disposed below (to measure restoration).
core.register({
  name: 'sidebar.workspaces',
  children: {
    'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' },
    'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' },
    'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
  },
}, () => null)

// The official action packages then register into those holes.
const archive = core.register({ name: 'sidebar.workspaces.session.menu.item', id: 'archive' }, () => null)

check('official browser declared its child holes',
  core.spec('sidebar.workspaces.session.menu.item')?.kind === 'list')
check('official action registered into a child hole',
  core.entries('sidebar.workspaces.session.menu.item').length === 1)

// Our replacement entry, at a lower priority, in the same single slot.
const ours = core.register({ name: 'sidebar.workspaces', priority: -100 }, () => null)

// `register` returns a disposer; winner identity is read off the entry.
// The official entry declares no priority, which the machinery reads as 0.
//
// `[0]` is the winner *by contract*, not by luck: `entriesOfSlot` projects each cell to
// its shadowing winner "in priority order" (single = one cell), and `register` keeps
// `entries` sorted by priority. So index 0 is the entry that renders.
const winner = () => core.entriesOfSlot('sidebar.workspaces')[0]
const winnerPriority = () => winner()?.options.priority ?? 0

check('lower priority wins the single slot',
  winnerPriority() === -100,
  `winner priority=${winnerPriority()}`)
check('the shadowed official entry stays on the ledger',
  core.entries('sidebar.workspaces').length === 2,
  `entries=${core.entries('sidebar.workspaces').length}`)
check('shadowing did NOT release the official child holes',
  core.spec('sidebar.workspaces.session.menu.item') !== undefined)
check('the official action is still registered',
  core.entries('sidebar.workspaces.session.menu.item').length === 1)

// Seam 1: can our entry re-declare the same children so it can render them?
let childError = null
try {
  core.register({
    name: 'sidebar.workspaces',
    priority: -200,
    children: { 'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' } },
  }, () => null)
} catch (error) {
  childError = error
}
// Both halves are asserted: the phrase alone would pass for any other error that happens
// to contain it, so the message must also name the child slot that was re-declared.
check('re-declaring an official child slot is REFUSED',
  childError !== null
    && /already declared/.test(childError.message)
    && childError.message.includes('sidebar.workspaces.session.menu.item'),
  childError?.message?.slice(0, 96))

// Disposing OUR entry restores the official one untouched. `register` returns
// a disposer, so identify the official entry by its ledger position.
const officialEntry = core.entries('sidebar.workspaces').find(e => (e.options.priority ?? 0) === 0)
ours()
check('disposing our entry restores the official browser',
  winner() === officialEntry,
  `winner is official=${winner() === officialEntry}`)
check('official children survive our whole lifetime',
  core.entries('sidebar.workspaces.session.menu.item').length === 1)

archive()

// ---------------------------------------------------------------------------
// Seam 2: can a replacement entry render the official action's slot at all?
// `renderSlot` is bound per entry and authorises only that entry's declared
// children, so our entry cannot reach a child it does not own.
// ---------------------------------------------------------------------------
const core2 = new SlotCore()
core2.register({
  name: 'root',
  children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' } },
}, () => null)
// Not disposed either: it is the official owner the following checks identify by its
// `priority === 0` ledger position, so it has to stay registered.
core2.register({
  name: 'sidebar.workspaces',
  children: { 'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' } },
}, () => null)

// The renderer authorises renderSlot against the rendering entry's children.
// Reproduce that rule exactly (see boundRenderSlot in the shipped renderer:
// `const declared = entry.children?.[key]`), which is what the renderer throws.
// Optional chaining mirrors that guard: a missing winner must be reported by the checks
// below, not crash the run with a `TypeError`.
const owns = (entry, key) => Object.hasOwn(entry?.children ?? {}, key)
const officialEntry2 = core2.entries('sidebar.workspaces').find(e => (e.options.priority ?? 0) === 0)
check('official entry owns the session-menu child',
  owns(officialEntry2, 'sidebar.workspaces.session.menu.item'))

// Our entry declares no children (it cannot — the slot is already declared). The binding
// is not kept: this probe ends here, and the point of this registration is the ledger row
// it leaves behind.
core2.register({ name: 'sidebar.workspaces', priority: -100 }, () => null)
const ourEntry2 = core2.entries('sidebar.workspaces').find(e => (e.options.priority ?? 0) === -100)
// `ourEntry2 !== undefined` is part of the assertion, not decoration: `owns` is
// null-safe, so a missing entry would otherwise make this check pass vacuously.
check('our entry does NOT own the session-menu child',
  ourEntry2 !== undefined && !owns(ourEntry2, 'sidebar.workspaces.session.menu.item'),
  ourEntry2 === undefined
    ? 'our entry was not found on the ledger'
    : 'so renderSlot for it would throw SlotOwnershipError')

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
// `process.exit()` here would truncate the summary when stdout is a pipe (CI, `| tee`),
// because those writes are asynchronous; setting the code lets Node flush and exit.
process.exitCode = failures.length === 0 ? 0 : 1
