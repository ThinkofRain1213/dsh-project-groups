/**
 * Behaviour test for the L1-2 project model and the grouping it produces.
 *
 * A project is a caller-supplied grouping, not a Workspace. This asserts that
 * the model's observable feeds `deriveGroups` the way the browser consumes it,
 * and that every verb the row menu drives reaches the Remote namespace.
 *
 * The model is driven against a stand-in for the mounted namespace — a real
 * `ProjectModel` and a real `deriveGroups`, with only the wire replaced. The
 * stand-in answers the same shape the Gateway does (`{ ok, value }`), so the
 * model's own unwrapping and error paths are exercised rather than bypassed.
 *
 * The wire round-trip itself is not simulated here: it was verified against a
 * live Host (see the commit message), where `projectGroups/*` answered over
 * `/api` and the domain landed in `$DSH_HOME/storages/project_groups.json`.
 *
 * `tree.ts` imports controller types only, but Node still evaluates the modules
 * behind those specifiers, and a client bundle's first act is to call
 * `window.__ModuleLoader__.load`. The stub below satisfies that. The vendored
 * and plugin sources are transpiled rather than strip-loaded because they use
 * constructor parameter properties; see `scripts/lib/ts-loader.mjs`.
 */
import { register } from 'node:module'

register('./lib/ts-loader.mjs', import.meta.url)

globalThis.window = { __ModuleLoader__: { load: () => {} } }

const { ProjectModel } = await import('../src/client/projects.ts')
const { deriveGroups, UNGROUPED_KEY } = await import('../src/vendored/client/tree.ts')
const { clientGrouping, installProjectModel } = await import('../src/client/grouping.ts')

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

/**
 * A stand-in for the mounted `projectGroups` namespace.
 *
 * It holds the same projection the Host does and applies each verb to it, so the
 * model's read path, its unwrapping and its change notification are all real.
 */
function fakeRemote({ failOn } = {}) {
  const state = { projects: [], assignments: {} }
  const calls = []
  const ok = value => Promise.resolve({ ok: true, value })
  const guard = name => {
    if (failOn === name) return Promise.resolve({ ok: false, error: { message: `${name} refused by host` } })
    return undefined
  }
  return {
    state,
    calls,
    async baseline() { return { ok: true, value: structuredClone(state) } },
    async create({ title }) {
      calls.push(['create', title])
      const refused = guard('create')
      if (refused !== undefined) return refused
      const project = {
        projectId: `p${state.projects.length + 1}`,
        title, docPath: '',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }
      state.projects.push(project)
      return ok({ project })
    },
    async rename({ projectId, title }) {
      calls.push(['rename', projectId, title])
      const refused = guard('rename')
      if (refused !== undefined) return refused
      const project = state.projects.find(p => p.projectId === projectId)
      if (project === undefined) return { ok: false, error: { message: 'unknown project' } }
      project.title = title
      return ok({ project })
    },
    async delete({ projectId }) {
      calls.push(['delete', projectId])
      const refused = guard('delete')
      if (refused !== undefined) return refused
      state.projects = state.projects.filter(p => p.projectId !== projectId)
      for (const [sessionId, owner] of Object.entries(state.assignments)) {
        if (owner === projectId) delete state.assignments[sessionId]
      }
      return ok(undefined)
    },
    async reorder({ projectId, beforeId }) {
      calls.push(['reorder', projectId, beforeId])
      const refused = guard('reorder')
      if (refused !== undefined) return refused
      const moving = state.projects.find(p => p.projectId === projectId)
      if (moving === undefined) return { ok: false, error: { message: 'unknown project' } }
      const rest = state.projects.filter(p => p.projectId !== projectId)
      const index = beforeId === undefined ? rest.length : rest.findIndex(p => p.projectId === beforeId)
      state.projects = [...rest.slice(0, index), moving, ...rest.slice(index)]
      return ok({ projectIds: state.projects.map(p => p.projectId) })
    },
    async assign({ sessionId, projectId }) {
      calls.push(['assign', sessionId, projectId])
      const refused = guard('assign')
      if (refused !== undefined) return refused
      state.assignments[sessionId] = projectId
      return ok({ sessionId, projectId })
    },
    async unassign({ sessionId }) {
      calls.push(['unassign', sessionId])
      const refused = guard('unassign')
      if (refused !== undefined) return refused
      const removed = Object.hasOwn(state.assignments, sessionId)
      delete state.assignments[sessionId]
      return ok({ sessionId, removed })
    },
    follow(signal) {
      // One baseline then nothing: the model's stream consumption is exercised
      // without a Host. The live stream was verified against a running Host.
      const frames = [{ type: 'baseline', value: structuredClone(state) }]
      return (async function* () {
        for (const frame of frames) if (!signal.aborted) yield frame
      })()
    },
  }
}

/** Start a model over a fresh stand-in. */
async function started(options) {
  const remote = fakeRemote(options)
  const model = new ProjectModel(remote)
  const stop = await model.start()
  return { model, remote, stop }
}

/** Let the stream's microtasks settle. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

// 1. A fresh install groups by an active override that claims nothing.
{
  const { model, stop } = await started()
  const snapshot = model.grouping.getSnapshot()
  check('a fresh model supplies an active (not absent) override', Array.isArray(snapshot), String(snapshot))
  check('a fresh model claims no project', snapshot.length === 0)
  const groups = groupsOf(model)
  check('a fresh model leaves every Session Ungrouped',
    groups.length === 1 && groups[0].key === UNGROUPED_KEY && groups[0].sessionCount === 3,
    groups.map(g => `${g.key}:${g.sessionCount}`).join(' '))
  stop()
}

// 2. Every verb reaches the namespace, and stays out of the local state until
//    the Host's projection says otherwise.
{
  const { model, remote, stop } = await started()
  await model.create('项目一')
  check('create reached the namespace', remote.calls.some(c => c[0] === 'create' && c[1] === '项目一'),
    JSON.stringify(remote.calls))
  check('create did not invent local state', model.list().length === 0,
    'the sidebar must not show a project the Host has not accepted')

  // The Host's projection is what updates the view.
  await model.start()
  const remoteState = remote.state
  check('the projection carries the Host state', remoteState.projects.length === 1)
  stop()
}

// 3. A started model adopts the baseline, and the row is marked as ours.
{
  const { model, remote, stop } = await started()
  await model.create('abc')
  // Re-read the projection the way the follow stream would.
  await model.start()
  const projects = model.list()
  check('the model lists what the Host holds', projects.length === 1 && projects[0].title === 'abc',
    JSON.stringify(projects.map(p => p.title)))
  const groups = groupsOf(model, projects.map(p => p.projectId))
  const row = groups.find(g => g.key === projects[0].projectId)
  check('the project renders as its own group', row !== undefined, groups.map(g => g.key).join(','))
  check('the project row carries kind=project', row?.kind === 'project', String(row?.kind))
  check('the project row carries no Workspace id', row?.workspaceId === undefined)
  check('unclaimed Sessions still trail under Ungrouped',
    groups.some(g => g.key === UNGROUPED_KEY && g.sessionCount === 3))
  stop()
}

// 4. Assignments place Sessions under their project, and only there.
{
  const { model, remote, stop } = await started()
  await model.create('a')
  await model.start()
  const projectId = model.list()[0].projectId
  await model.assign('s1', projectId)
  await model.assign('s2', projectId)
  await model.start()

  check('the assignment map reaches the model',
    model.projectOf('s1') === projectId && model.projectOf('s2') === projectId,
    JSON.stringify(remote.state.assignments))

  const groups = groupsOf(model, [projectId])
  const row = groups.find(g => g.key === projectId)
  check('the project holds exactly its assigned Sessions', row?.sessionCount === 2,
    String(row?.sessionCount))
  check('an unassigned Session stays Ungrouped',
    groups.find(g => g.key === UNGROUPED_KEY)?.sessionCount === 1)
  stop()
}

// 5. The snapshot identity is stable until the projection actually changes.
{
  const { model, remote, stop } = await started()
  await model.create('a')
  await model.start()
  const first = model.grouping.getSnapshot()
  check('snapshot identity is stable across reads', model.grouping.getSnapshot() === first,
    'the selector compares identity, so a fresh array per read would re-render every consumer')
  await model.create('b')
  await model.start()
  check('a real change yields a new snapshot', model.grouping.getSnapshot() !== first)
  check('the changed snapshot carries both projects', model.list().length === 2)
  stop()
}

// 6. A frame repeating the same state must not invalidate the snapshot.
{
  const { model, remote, stop } = await started()
  await model.create('a')
  await model.start()
  const settled = model.grouping.getSnapshot()
  const notifications = { count: 0 }
  model.grouping.subscribe(() => { notifications.count += 1 })
  // Re-deliver the identical projection: the Host re-projects on every write, so
  // an unchanged frame is the common case and must be cheap.
  await model.start()
  check('an unchanged projection does not notify', notifications.count === 0,
    `notified ${notifications.count}x`)
  check('an unchanged projection keeps the snapshot', model.grouping.getSnapshot() === settled)
  check('the stand-in still holds its state', remote.state.projects.length === 1)
  stop()
}

// 7. Deleting a project returns its Sessions to Ungrouped.
{
  const { model, stop } = await started()
  await model.create('gone')
  await model.start()
  const projectId = model.list()[0].projectId
  await model.assign('s1', projectId)
  await model.start()
  check('the Session was filed', groupsOf(model, [projectId]).find(g => g.key === projectId)?.sessionCount === 1)

  await model.remove(projectId)
  await model.start()
  check('after deleting the project every Session is Ungrouped again',
    groupsOf(model).length === 1 && groupsOf(model)[0].key === UNGROUPED_KEY,
    groupsOf(model).map(g => g.key).join(','))
  check('the deleted group is gone', !model.list().some(p => p.projectId === projectId))
  stop()
}

// 8. Reordering follows the Host's order, not the call order.
{
  const { model, stop } = await started()
  await model.create('first')
  await model.start()
  await model.create('second')
  await model.start()
  const [firstId, secondId] = model.list().map(p => p.projectId)
  await model.reorder(secondId, firstId)
  await model.start()
  check('reorder moved the project before its anchor',
    model.list().map(p => p.title).join(',') === 'second,first',
    model.list().map(p => p.title).join(','))
  void secondId
  stop()
}

// 9. A refusal reaches the caller, and does not change the local view.
{
  const { model, stop } = await started({ failOn: 'rename' })
  await model.create('a')
  await model.start()
  const projectId = model.list()[0].projectId
  let message = ''
  try {
    await model.rename(projectId, 'b')
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('a refused verb throws with the Host message', message === 'rename refused by host', message)
  check('a refused verb leaves the local view unchanged', model.list()[0].title === 'a',
    model.list()[0].title)
  stop()
}

// 10. Early subscribers are woken when the model arrives.
{
  const seen = []
  const unsubscribe = clientGrouping.subscribe(() => { seen.push(clientGrouping.getSnapshot().length) })
  check('a snapshot read before install is the empty override',
    clientGrouping.getSnapshot().length === 0)
  const { model, stop } = await started()
  await model.create('early')
  await model.start()
  installProjectModel(model)
  check('installing the model wakes an early subscriber', seen.length > 0,
    `notified ${seen.length}x`)
  check('and its next read sees the Host state', clientGrouping.getSnapshot().length === 1,
    String(clientGrouping.getSnapshot().length))
  unsubscribe()
  stop()
}

// 11. Every call is a distinct project, keyed by a generated id rather than title.
{
  const { model, stop } = await started()
  await model.create('same')
  await model.start()
  await model.create('same')
  await model.start()
  const ids = model.list().map(p => p.projectId)
  check('same-titled projects get distinct ids', ids[0] !== ids[1], ids.join(','))
  check('both render as separate rows', groupsOf(model).length === 3, `groups=${groupsOf(model).length - 1}`)
  stop()
}

await tick()
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
