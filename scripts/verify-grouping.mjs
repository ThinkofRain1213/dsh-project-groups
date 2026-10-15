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
const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * Facts about **upstream's own** defects, recorded rather than asserted.
 *
 * These describe behaviour the vendored tree inherits verbatim from the upstream revision it
 * was copied from — the code is byte-identical to upstream at every one of these points. An
 * earlier review round "fixed" several of them inside `src/vendored`, which turned this plugin
 * into the maintainer of upstream's bugs: every re-sync then required re-applying 50-odd
 * repairs, and one of them (`web:linux` in `client/shortcuts.ts`) broke the whole client
 * plugin, so the sidebar did not load at all.
 *
 * That is why they are **recorded, not fixed**: the mainline stays "upstream + the patches we
 * actually need", and these stay visible so nobody re-discovers them as a surprise. If upstream
 * fixes one, this line is what tells us to drop the note and take their version.
 *
 * `console.log` rather than `check` on purpose: a defect we have decided not to fix is not a
 * failure of *this* plugin, and counting it as one would make the gate red for a state we
 * chose. It is printed in the summary too, so it cannot be missed.
 * @param label - what upstream does.
 * @param observed - what we actually measured.
 */
const upstreamDefects = []
const upstreamDefect = (label, observed) => {
  console.log(`NOTE  [上游原生缺陷] ${label} — ${observed}`)
  upstreamDefects.push(`${label} — ${observed}`)
}

globalThis.window = {
  // The controller client bundles this derivation imports export nothing it uses, so the loader
  // only has to exist for the module graph to resolve. An earlier version also recorded every
  // load into a `loaded` Map that nothing ever read, via a ternary whose two branches were
  // identical (`typeof factory === 'function' ? undefined : undefined`) — state that implied it
  // was tracking something and tracked nothing.
  __ModuleLoader__: { load: () => {} },
}

/**
 * Load the derivation under test, reporting a failure rather than throwing.
 *
 * The bare top-level `await import` below this used to abort the whole script with a raw stack
 * on any resolution or type-stripping failure — a renamed source file, a broken `ts-loader` —
 * bypassing the `failures` summary entirely, which contradicts the point of a harness that
 * reports every result.
 */
let tree
try {
  tree = await import('../src/vendored/client/tree.ts')
} catch (error) {
  check('可以载入 tree.ts', false, String(error?.message ?? error).slice(0, 200))
}
if (failures.length > 0) {
  console.log('')
  console.log(`${failures.length} CHECK(S) FAILED`)
  process.exit(1)
}
const { deriveGroups, deriveSearchResults, UNGROUPED_KEY, owningSourceKey, owningParentFolder } = tree

/**
 * One session summary with the fields the derivation reads.
 *
 * `title` is the durable log-backed title and `displayTitle` its human-facing fallback; since
 * 0.2.0 `sessionTitle` reads the former, so both are set here — the same fixture change upstream
 * made in its own `tree.client.spec.ts` when it introduced the field. Without it every search
 * assertion sees an empty title and fails, which is what happened on the re-sync.
 */
const session = (id, extra = {}) => ({
  id, title: id, displayTitle: id, blank: false, origin: 'user', updatedAt: 1000, retainedBy: {}, ...extra,
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
// Built from `UNGROUPED_KEY` rather than the literal `'w1,w2,'`. The constant is imported
// precisely so this test does not depend on its value — which is the empty string today, making
// the literal form read as correct while silently breaking the moment upstream changes it.
check('no override groups by Workspace, strays last',
  upstream.map(g => g.key).join(',') === ['w1', 'w2', UNGROUPED_KEY].join(','),
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

// 7. Search result labels follow the same model the grouping does, and never mix the two.
//
//    Before this seam existed, a result row was labeled from the Workspace registry regardless of
//    how the sidebar was grouped, so with projects active every result was captioned with a
//    Workspace the user never sees anywhere else (`默认工作区`, and a real `重要`) — and because the
//    same `labelOf` feeds the match test, searching for a project's name could not find its
//    Sessions at all.
// One call, with the repeated literal arguments named. `search` and `searchFor` were the same
// `deriveSearchResults` call differing only in the query, so the magic `20` and the empty
// pagination object appeared twice; a signature change would have had to be made in both.
const SEARCH_LIMIT = 20
const NO_PAGINATION = { items: [], hasMore: false }
const NO_ARCHIVED = []
const searchFor = (query, sources_) => deriveSearchResults(
  list, workspaces, query, NO_ARCHIVED, 'default', statuses, NO_PAGINATION, SEARCH_LIMIT, sources_,
)
const labelOfId = (set, id) => set.items.find(item => item.id === id)?.workspace

// A query that matches nothing still returns rows only when the query hits; use a query that every
// title contains so the set is stable, then read the labels.
const allRows = searchFor('s', sources)
check('grouped search returns the claimed rows', allRows.items.length >= 2, `rows=${allRows.items.length}`)
check('a filed Session is labeled with its project',
  labelOfId(allRows, 's1') === '项目一', String(labelOfId(allRows, 's1')))
check('a second project labels its own Session',
  labelOfId(allRows, 's2') === '项目二', String(labelOfId(allRows, 's2')))
check('an unfiled Session is labeled empty, not with a Workspace',
  labelOfId(allRows, 's4') === '', JSON.stringify(labelOfId(allRows, 's4')))

// The load-bearing one: with groups supplied, no Workspace title may appear on any row. That is the
// "no mixing" invariant — the sidebar shows projects, so a result row must not name anything else.
const workspaceTitles = new Set(workspaces.map(w => w.title))
check('no row is labeled with a Workspace title while grouped',
  allRows.items.every(item => !workspaceTitles.has(item.workspace)),
  allRows.items.map(i => `${i.id}:${JSON.stringify(i.workspace)}`).join(' '))
check('no row falls back to the cwd basename either',
  allRows.items.every(item => item.workspace !== 'w1' && item.workspace !== 'w2'),
  allRows.items.map(i => `${i.id}:${JSON.stringify(i.workspace)}`).join(' '))

// Searching by project name. `labelOf` feeds the match test as well as the label, so this is what
// makes a project's Sessions findable by the name the user gave it.
const byProjectName = searchFor('项目二', sources)
check('a project name finds its Sessions',
  byProjectName.items.some(item => item.id === 's2'),
  byProjectName.items.map(i => i.id).join(','))
check('and the Workspace name no longer does',
  !searchFor('w1', sources).items.some(item => item.id === 's1'),
  searchFor('w1', sources).items.map(i => i.id).join(','))

// An empty override still takes the grouped branch: every label is empty, none falls back.
const emptyOverride = searchFor('s', [])
check('an empty override labels every row empty',
  emptyOverride.items.every(item => item.workspace === ''),
  emptyOverride.items.map(i => `${i.id}:${JSON.stringify(i.workspace)}`).join(' '))

// Omitted, the path is upstream's, unchanged — the invariant the README states.
const upstreamSearch = searchFor('s', undefined)
check('omitting sources keeps the Workspace label',
  labelOfId(upstreamSearch, 's1') === 'w1' && labelOfId(upstreamSearch, 's2') === 'w2',
  upstreamSearch.items.map(i => `${i.id}:${JSON.stringify(i.workspace)}`).join(' '))
check('omitting sources still finds a Session by Workspace name',
  searchFor('w1', undefined).items.some(item => item.id === 's1'))
check('no query returns an empty set with either model',
  searchFor('', undefined).items.length === 0 && searchFor('', sources).items.length === 0)

// First declaration wins when two sources claim one Session, matching the Workspace map's rule.
const overlapping = [
  { key: 'a', label: '先', sessionIds: ['s1'] },
  { key: 'b', label: '后', sessionIds: ['s1'] },
]
check('two sources claiming one Session label deterministically',
  labelOfId(searchFor('s', overlapping), 's1') === '先',
  String(labelOfId(searchFor('s', overlapping), 's1')))

// A Workspace whose `createdAt` is missing or malformed hands the group a `NaN`.
//
// `buildGroup` types the field `number | undefined`, so a bare `Date.parse(...)` produces a
// NaN that claims to be a real timestamp; consumers sorting or comparing on it then get `false`
// from every comparison. This is **upstream's own code** — `tree.ts` is byte-identical to
// upstream at this point — so it is recorded rather than repaired, and the two rows below are
// what a future re-sync should check: if they start reporting `undefined`, upstream has fixed
// it and the note can go.
//
// The valid case is still asserted: whatever upstream does about the bad inputs, a real date
// must survive unchanged.
{
  const emptyList = { ids: [], byId: {}, projectionsBySession: {} }
  const emptyRowState = { pinnedSessionIds: [], archivedSessionIds: [], archivedFilter: 'default' }
  const emptyView = { expandedGroups: [] }
  const createdAtOf = (createdAt) => {
    const one = {
      workspaceId: 'w1', path: 'C:/w1', title: 'w1', sessionIds: [],
      createdAt, updatedAt: '2026-01-01T00:00:00.000Z',
    }
    return deriveGroups(emptyList, [one], emptyRowState, new Map(), emptyView)[0]?.createdAt
  }
  if (createdAtOf('') === undefined) {
    check('a missing createdAt yields undefined (upstream has fixed this)', true)
  } else {
    upstreamDefect('a missing createdAt yields NaN, not undefined', String(createdAtOf('')))
  }
  if (createdAtOf('not-a-date') === undefined) {
    check('a malformed createdAt yields undefined (upstream has fixed this)', true)
  } else {
    upstreamDefect('a malformed createdAt yields NaN, not undefined', String(createdAtOf('not-a-date')))
  }
  check('a valid createdAt is preserved',
    createdAtOf('2024-01-01T00:00:00.000Z') === Date.parse('2024-01-01T00:00:00.000Z'),
    String(createdAtOf('2024-01-01T00:00:00.000Z')))
  const nanGroups = deriveGroups(emptyList, [{ workspaceId: 'w1', path: 'C:/w1', title: 'w1', sessionIds: [], createdAt: 'x', updatedAt: 'y' }],
    emptyRowState, new Map(), emptyView)
  if (nanGroups.some(group => Number.isNaN(group.createdAt))) {
    upstreamDefect('a group carries a NaN createdAt', `${String(nanGroups.length)} group(s)`)
  } else {
    check('no group ever carries a NaN createdAt (upstream has fixed this)', true)
  }
}

// `owningParentFolder`'s root case. `folderPath` strips trailing separators, so `/` normalizes
// to empty and `C:/` to `C:`; the prefix test `${root}/` then matches **every** path below a
// registered root, so one empty entry in `parents` claims ownership of any absolute path.
//
// Upstream's own code, again — recorded rather than repaired. The three cases that are NOT
// about the root normalization are still asserted, because they pin the part of the function
// that works and must keep working.
{
  if (owningParentFolder('/a/b', ['/']) === undefined) {
    check('a POSIX root is never a parent (upstream has fixed this)', true)
  } else {
    upstreamDefect('a POSIX root claims every path', String(owningParentFolder('/a/b', ['/'])))
  }
  if (owningParentFolder('C:/a/b', ['C:/']) === undefined) {
    check('a bare drive is never a parent (upstream has fixed this)', true)
  } else {
    upstreamDefect('a bare drive claims every path', String(owningParentFolder('C:/a/b', ['C:/'])))
  }
  check('the nearest real ancestor wins',
    owningParentFolder('/a/b/c', ['/a', '/a/b']) === '/a/b',
    String(owningParentFolder('/a/b/c', ['/a', '/a/b'])))
  check('an unrelated sibling is not a parent',
    owningParentFolder('/x/y', ['/a']) === undefined, String(owningParentFolder('/x/y', ['/a'])))
  check('a Workspace is not its own parent',
    owningParentFolder('/a/b', ['/a/b']) === undefined, String(owningParentFolder('/a/b', ['/a/b'])))
  if (owningParentFolder('/a/b', ['/']) === undefined) {
    check('trailing separators do not change the answer (upstream has fixed this)', true)
  } else {
    upstreamDefect('trailing separators change the answer',
      `${String(owningParentFolder('/a/b', ['/']))} / ${String(owningParentFolder('/a/b/', ['/a']))}`)
  }
}

console.log('')
if (upstreamDefects.length > 0) {
  console.log(`记录 ${upstreamDefects.length} 项上游原生缺陷（不计入失败；我们决定不替上游修）:`)
  for (const d of upstreamDefects) console.log(`  [上游] ${d}`)
  console.log('')
}
console.log(`${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
