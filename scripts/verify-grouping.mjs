/**
 * Unit test for the L1a grouping seam: `deriveGroups(..., sources)`.
 *
 * This is the load-bearing behaviour of this round, so it is tested against the
 * real derivation rather than a copy of it — the import is the vendored module
 * itself, loaded through Node's type stripping.
 *
 * `tree.ts` imports controller *types* only, but Node still evaluates the
 * modules behind those specifiers, and a client bundle's first act is to call
 * `window.__ModuleLoader__.load`. The stub below satisfies that well enough for
 * module evaluation; none of those packages' runtime behaviour is exercised.
 *
 * What is asserted:
 *   1. No override  -> grouping by the Host Workspace registry (upstream path).
 *   2. `[]`         -> one Ungrouped group holding every visible Session.
 *   3. Real groups  -> caller groups in order, strays in Ungrouped last.
 *   4. Both paths agree on member visibility (archived filter, blank rule).
 *   5. Caller groups carry no `workspaceId`, so the Workspace-only row
 *      affordances (rename/delete menu, workspace drag, startSession) stay off.
 */
const loaded = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      // The controller client bundles export nothing this derivation uses.
      loaded.set(id, typeof factory === 'function' ? undefined : undefined)
    },
  },
}

const { deriveGroups, UNGROUPED_KEY, owningSourceKey } = await import('../src/vendored/client/tree.ts')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** One session summary with the fields the derivation reads. */
const session = (id, extra = {}) => ({
  id, displayTitle: id, blank: false, origin: 'user', updatedAt: 1000, retainedBy: {}, ...extra,
})

const list = {
  phase: 'ready',
  ids: ['s1', 's2', 's3', 's4'],
  byId: {
    s1: session('s1'),
    s2: session('s2'),
    s3: session('s3'),
    s4: session('s4'),
  },
  // Session status summaries the row derivation reads; empty means no
  // subagent catalog and no pending interaction for any id.
  projectionsBySession: {},
}
const rowState = { pinnedSessionIds: [], archivedSessionIds: [], archivedFilter: 'default' }
const view = { expandedGroups: ['w', 'w1', 'w2', UNGROUPED_KEY] }
const statuses = new Map()

const workspace = (workspaceId, sessionIds) => ({
  workspaceId, path: `C:/${workspaceId}`, title: workspaceId, sessionIds,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaces = [workspace('w1', ['s1']), workspace('w2', ['s2'])]

// 1. No override: the upstream grouping model, unchanged. s3 and s4 are
//    unaccounted for by any Workspace, so upstream already trails them under
//    its own Ungrouped bucket — the same bucket the override reuses.
const upstream = deriveGroups(list, workspaces, rowState, statuses, view)
check('no override groups by Workspace, strays last',
  upstream.map(g => g.key).join(',') === 'w1,w2,',
  upstream.map(g => `${g.key}:${g.sessionCount}`).join(' '))
check('no override: workspace groups carry their Workspace id',
  upstream[0]?.workspaceId === 'w1' && upstream[1]?.workspaceId === 'w2')
check('no override: the stray bucket has no Workspace id',
  upstream[2]?.key === UNGROUPED_KEY && upstream[2]?.workspaceId === undefined)

// 2. Empty override: every visible Session under Ungrouped.
const empty = deriveGroups(list, workspaces, rowState, statuses, view, [])
check('empty override yields exactly one group', empty.length === 1, `groups=${empty.length}`)
check('empty override group is Ungrouped', empty[0]?.key === UNGROUPED_KEY, `key=${JSON.stringify(empty[0]?.key)}`)
check('empty override holds every visible Session', empty[0]?.sessionCount === 4, `count=${empty[0]?.sessionCount}`)
check('empty override leaves the Ungrouped label empty (renderer localizes it)', empty[0]?.label === '')
check('empty override claims no Workspace', empty.every(g => g.workspaceId === undefined))

// 3. Real groups: caller order, strays last.
const sources = [
  { key: 'p1', label: '项目一', sessionIds: ['s1', 's3'] },
  { key: 'p2', label: '项目二', sessionIds: ['s2'] },
]
const grouped = deriveGroups(list, workspaces, rowState, statuses, view, sources)
check('caller groups come first, in caller order',
  grouped.length === 3 && grouped.slice(0, 2).map(g => g.key).join(',') === 'p1,p2',
  grouped.map(g => `${g.key}:${g.sessionCount}`).join(' '))
check('caller group labels are preserved', grouped[0]?.label === '项目一' && grouped[1]?.label === '项目二')
check('unclaimed Sessions trail under Ungrouped last',
  grouped[2]?.key === UNGROUPED_KEY && grouped[2]?.sessionCount === 1,
  `last=${grouped[2]?.key}:${grouped[2]?.sessionCount}`)
check('caller groups carry no workspaceId (Workspace-only affordances stay off)',
  grouped.slice(0, 2).every(g => g.workspaceId === undefined))
check('ungrouped bucket still carries no workspaceId', grouped[2]?.workspaceId === undefined)

// 4. Visibility rules are identical on both paths.
const archivedState = { ...rowState, archivedSessionIds: ['s2'], archivedFilter: 'default' }
const archivedUpstream = deriveGroups(list, workspaces, archivedState, statuses, view)
const archivedEmpty = deriveGroups(list, workspaces, archivedState, statuses, view, [])
check('archived Sessions stay hidden under an override',
  archivedEmpty[0]?.sessionCount === 3, `count=${archivedEmpty[0]?.sessionCount}`)
check('the override does not change what is visible overall',
  archivedUpstream.reduce((n, g) => n + g.sessionCount, 0) === archivedEmpty.reduce((n, g) => n + g.sessionCount, 0))

const blankList = {
  ...list,
  byId: { ...list.byId, s1: session('s1', { blank: true }) },
}
const blankEmpty = deriveGroups(blankList, workspaces, rowState, statuses, view, [])
check('an unselected blank Session stays hidden under an override',
  blankEmpty[0]?.sessionCount === 3, `count=${blankEmpty[0]?.sessionCount}`)

// 5. owningSourceKey mirrors owningGroupKey for the current-group highlight.
check('owningSourceKey finds the claiming group', owningSourceKey(sources, 's3') === 'p1')
check('owningSourceKey falls back to Ungrouped', owningSourceKey(sources, 's4') === UNGROUPED_KEY)

// 6. Under an override the Ungrouped bucket always renders, empty included.
//
//    It is not only a container: it is the drop target that takes a Session back
//    out of a caller-supplied group. Hiding it when every Session is filed would
//    remove the only way out.
const allClaimed = [
  { key: 'p1', label: '项目一', sessionIds: ['s1', 's3', 's2', 's4'] },
]
const fullyGrouped = deriveGroups(list, workspaces, rowState, statuses, view, allClaimed)
check('Ungrouped still renders when every Session is claimed',
  fullyGrouped.length === 2 && fullyGrouped[1]?.key === UNGROUPED_KEY,
  fullyGrouped.map(g => `${g.key}:${g.sessionCount}`).join(' '))
check('and that empty Ungrouped bucket holds nothing', fullyGrouped[1]?.sessionCount === 0)
check('the empty bucket is still the caller-localized one',
  fullyGrouped[1]?.label === '' && fullyGrouped[1]?.workspaceId === undefined)

// The shipped Workspace path keeps the original rule: it has no caller-supplied
// group to leave, so an empty bucket there would be new UI for no reason.
const upstreamAllClaimed = deriveGroups(list, workspaces, rowState, statuses, view)
check('groupByWorkspace keeps the strays-only rule',
  upstreamAllClaimed.every(g => g.key !== UNGROUPED_KEY || g.sessionCount > 0),
  upstreamAllClaimed.map(g => `${g.key}:${g.sessionCount}`).join(' '))

// The archived-only view lists archives rather than the group inventory, so an
// empty bucket stays hidden there.
const onlyArchived = { ...rowState, archivedFilter: 'only' }
const onlyView = deriveGroups(list, workspaces, onlyArchived, statuses, view, allClaimed)
check('the archived-only view hides the empty Ungrouped bucket',
  onlyView.every(g => g.key !== UNGROUPED_KEY),
  onlyView.map(g => `${g.key}:${g.sessionCount}`).join(' '))
check('owningSourceKey on an empty source is Ungrouped', owningSourceKey([], 's1') === UNGROUPED_KEY)

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
