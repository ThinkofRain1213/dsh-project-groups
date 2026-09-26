/**
 * Behaviour test for the L1-1 project model and the grouping it produces.
 *
 * A project is a caller-supplied grouping, not a Workspace: this asserts that
 * the model's observable feeds `deriveGroups` the way the browser consumes it,
 * and that every verb the row menu drives actually changes the snapshot.
 *
 * The model is driven through the real `ProjectModel`, and the grouping it
 * emits is fed to the real `deriveGroups`, so the two halves are checked
 * against each other rather than against a restatement of the shape.
 *
 * `tree.ts` imports controller types only, but Node still evaluates the modules
 * behind those specifiers, and a client bundle's first act is to call
 * `window.__ModuleLoader__.load`. The stub below satisfies that.
 */
globalThis.window = { __ModuleLoader__: { load: () => {} } }

const { ProjectModel } = await import('../src/client/projects.ts')
const { deriveGroups, UNGROUPED_KEY } = await import('../src/vendored/client/tree.ts')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const session = (id, extra = {}) => ({
  id, displayTitle: id, blank: false, origin: 'user', updatedAt: 1000, retainedBy: {}, ...extra,
})
const list = {
  phase: 'ready',
  ids: ['s1', 's2', 's3'],
  byId: { s1: session('s1'), s2: session('s2'), s3: session('s3') },
  projectionsBySession: {},
}
const rowState = { pinnedSessionIds: [], archivedSessionIds: [], archivedFilter: 'default' }
const statuses = new Map()

/** Derive the sidebar's groups from one model, the way the browser does. */
const groupsOf = (model, expanded = []) => deriveGroups(
  list, [], rowState, statuses, { expandedGroups: expanded }, model.grouping.getSnapshot(),
)

// 1. A fresh model groups by an active override that claims nothing.
{
  const model = new ProjectModel()
  const snapshot = model.grouping.getSnapshot()
  check('a fresh model supplies an active (not absent) override', Array.isArray(snapshot), String(snapshot))
  check('a fresh model claims no project', snapshot.length === 0)
  const groups = groupsOf(model)
  check('a fresh model leaves every Session Ungrouped',
    groups.length === 1 && groups[0].key === UNGROUPED_KEY && groups[0].sessionCount === 3,
    groups.map(g => `${g.key}:${g.sessionCount}`).join(' '))
}

// 2. Create appends, and the row is marked as ours so the region gives it a menu.
{
  const model = new ProjectModel()
  const created = model.create('项目一')
  check('create returns the new project', created.title === '项目一' && created.id !== '')
  check('create appends in order', model.list().map(p => p.title).join(',') === '项目一')

  const groups = groupsOf(model, [created.id])
  const projectRow = groups.find(g => g.key === created.id)
  check('the project renders as its own group', projectRow !== undefined, groups.map(g => g.key).join(','))
  check('the project row carries the caller title', projectRow?.label === '项目一')
  check('the project row is marked kind=project', projectRow?.kind === 'project', String(projectRow?.kind))
  check('the project row carries no Workspace id', projectRow?.workspaceId === undefined)
  check('unclaimed Sessions still trail under Ungrouped',
    groups.some(g => g.key === UNGROUPED_KEY && g.sessionCount === 3))
}

// 3. The snapshot identity is stable until something changes.
{
  const model = new ProjectModel()
  model.create('a')
  const first = model.grouping.getSnapshot()
  check('snapshot identity is stable across reads', model.grouping.getSnapshot() === first,
    'the selector compares identity, so a fresh array per read would re-render every consumer')
  model.create('b')
  check('a real change yields a new snapshot', model.grouping.getSnapshot() !== first)
}

// 4. Subscribers are notified on every verb, and only on a real change.
{
  const model = new ProjectModel()
  let notifications = 0
  const dispose = model.grouping.subscribe(() => { notifications += 1 })
  const a = model.create('a')
  const b = model.create('b')
  check('create notifies a subscriber', notifications === 2, `notified ${notifications}x`)

  check('rename of a known project reports success', model.rename(a.id, 'A') === true)
  check('rename applies', model.get(a.id)?.title === 'A')
  check('rename notifies', notifications === 3, `notified ${notifications}x`)
  check('rename of an unknown project reports failure', model.rename('nope', 'x') === false)

  check('reorder reports a change', model.reorder(b.id, a.id) === true)
  check('reorder moved the project before the anchor',
    model.list().map(p => p.title).join(',') === 'b,A', model.list().map(p => p.title).join(','))
  check('reorder to the same position reports no change', model.reorder(b.id, a.id) === false)

  check('delete reports success', model.delete(a.id) === true)
  check('delete removes only that project', model.list().map(p => p.title).join(',') === 'b')
  const settled = notifications
  check('delete of an unknown project reports failure and does not notify',
    model.delete('nope') === false && notifications === settled)

  dispose()
  model.create('c')
  check('a disposed subscriber stops hearing changes', notifications === settled,
    `notified ${notifications}x after dispose`)
}

// 5. Deleting a project returns its Sessions to Ungrouped without touching them.
{
  const model = new ProjectModel()
  const project = model.create('gone')
  const before = groupsOf(model, [project.id])
  model.delete(project.id)
  const after = groupsOf(model)
  check('after deleting the project every Session is Ungrouped again',
    after.length === 1 && after[0].key === UNGROUPED_KEY && after[0].sessionCount === 3,
    after.map(g => `${g.key}:${g.sessionCount}`).join(' '))
  check('the deleted group is gone', !after.some(g => g.key === project.id))
  check('the derived rows were not mutated in place', before.length === 2)
}

// 6. Each call is a distinct project.
{
  const model = new ProjectModel()
  const ids = [model.create('a').id, model.create('a').id]
  check('same-titled projects get distinct ids', ids[0] !== ids[1])
  check('both render as separate rows', groupsOf(model).length === 3, `groups=${groupsOf(model).length - 1}`)
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
