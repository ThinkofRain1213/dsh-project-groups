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
const { clientExpansions, clientGrouping, installProjectModel } = await import('../src/client/grouping.ts')

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
  const state = { projects: [], assignments: {}, expansions: {} }
  const calls = []
  const ok = value => Promise.resolve({ ok: true, value })
  const guard = name => {
    if (failOn === name) return Promise.resolve({ ok: false, error: { message: `${name} refused by host` } })
    return undefined
  }
  // Stream subscribers, woken on every landed write. The real Host re-projects a
  // full baseline after each one, and that is what confirms or corrects an
  // optimistic local value — a fake that only ever sends its opening baseline
  // would leave an optimistic write looking like a bug.
  const watchers = new Set()
  const landed = () => { for (const notify of [...watchers]) notify() }
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
      landed()
      return ok({ project })
    },
    async rename({ projectId, title }) {
      calls.push(['rename', projectId, title])
      const refused = guard('rename')
      if (refused !== undefined) return refused
      const project = state.projects.find(p => p.projectId === projectId)
      if (project === undefined) return { ok: false, error: { message: 'unknown project' } }
      project.title = title
      landed()
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
      delete state.expansions[projectId]
      landed()
      return ok(undefined)
    },
    async setExpanded({ projectId, expanded }) {
      calls.push(['setExpanded', projectId, expanded])
      const refused = guard('setExpanded')
      if (refused !== undefined) return refused
      state.expansions[projectId] = expanded
      landed()
      return ok({ projectId, expanded })
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
      landed()
      return ok({ projectIds: state.projects.map(p => p.projectId) })
    },
    async assign({ sessionId, projectId }) {
      calls.push(['assign', sessionId, projectId])
      const refused = guard('assign')
      if (refused !== undefined) return refused
      state.assignments[sessionId] = projectId
      landed()
      return ok({ sessionId, projectId })
    },
    async unassign({ sessionId }) {
      calls.push(['unassign', sessionId])
      const refused = guard('unassign')
      if (refused !== undefined) return refused
      const removed = Object.hasOwn(state.assignments, sessionId)
      delete state.assignments[sessionId]
      landed()
      return ok({ sessionId, removed })
    },
    follow(signal) {
      // An opening baseline, then one fresh projection per landed write — the
      // shape the real Host's `follow` has.
      const queue = [{ type: 'baseline', value: structuredClone(state) }]
      let wake
      const notify = () => {
        queue.push({ type: 'baseline', value: structuredClone(state) })
        const pending = wake
        wake = undefined
        pending?.()
      }
      watchers.add(notify)
      signal.addEventListener('abort', () => { watchers.delete(notify); wake?.() }, { once: true })
      return (async function* () {
        while (!signal.aborted) {
          if (queue.length === 0) await new Promise(resolve => { wake = resolve })
          while (queue.length > 0) {
            const frame = queue.shift()
            if (signal.aborted) return
            yield frame
          }
        }
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

// 2. Every verb reaches the namespace, and the view follows the Host rather than
//    the call.
{
  const { model, remote, stop } = await started()
  await model.create('项目一')
  check('create reached the namespace', remote.calls.some(c => c[0] === 'create' && c[1] === '项目一'),
    JSON.stringify(remote.calls))
  check('the Host projection is what carries the new project',
    model.list().map(p => p.title).join(',') === '项目一',
    JSON.stringify(model.list().map(p => p.title)))
  stop()
}

// 2b. A refused write leaves the view untouched: the projection is the only
//     source, so nothing is shown that the Host did not accept.
{
  const { model, stop } = await started({ failOn: 'create' })
  let threw = false
  try {
    await model.create('never accepted')
  } catch {
    threw = true
  }
  check('a refused create rejects', threw)
  check('and invents no local project', model.list().length === 0,
    JSON.stringify(model.list().map(p => p.title)))
  check('and claims no group for it', groupsOf(model).length === 1,
    groupsOf(model).map(g => g.key).join(','))
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

// 10. Early subscribers on both seats are woken when the model arrives.
//
//     The browser registers its hooks during the vendored `apply`, which can
//     precede the Remote baseline, so both observables must hold their early
//     listeners and hand them to the model on install. This is the one place the
//     install happens, so both seats are exercised together — a later install
//     would replace the module-level model and leave a subscriber bound to the
//     old one.
{
  const seenGroups = []
  const seenExpansions = []
  const unsubscribeGroups = clientGrouping.subscribe(() => { seenGroups.push(clientGrouping.getSnapshot().length) })
  const unsubscribeExpansions = clientExpansions.subscribe(() => { seenExpansions.push(clientExpansions.getSnapshot()) })
  check('a snapshot read before install is the empty override',
    clientGrouping.getSnapshot().length === 0)
  check('and the expansion seat reads empty before install',
    Object.keys(clientExpansions.getSnapshot()).length === 0)

  const { model, stop } = await started()
  await model.create('early')
  await model.start()
  const projectId = model.list()[0].projectId
  await model.setExpanded(projectId, true)
  installProjectModel(model)

  check('installing the model wakes an early grouping subscriber', seenGroups.length > 0,
    `notified ${seenGroups.length}x`)
  check('and its next read sees the Host state', clientGrouping.getSnapshot().length === 1,
    String(clientGrouping.getSnapshot().length))
  check('installing the model wakes an early expansion subscriber', seenExpansions.length > 0,
    `notified ${seenExpansions.length}x`)
  check('and its next read sees the recorded expansion',
    clientExpansions.getSnapshot()[projectId] === true,
    JSON.stringify(clientExpansions.getSnapshot()))
  unsubscribeGroups()
  unsubscribeExpansions()
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

// 12. Expansion state: the plugin's own, and the absent/false distinction the
//     browser's auto-open rule depends on.
{
  const { model, remote, stop } = await started()
  await model.create('abc')
  await model.start()
  const projectId = model.list()[0].projectId

  check('a fresh project has no expansion entry',
    model.expansions.getSnapshot()[projectId] === undefined,
    JSON.stringify(model.expansions.getSnapshot()))

  await model.setExpanded(projectId, true)
  check('the write reached the namespace',
    remote.calls.some(c => c[0] === 'setExpanded' && c[1] === projectId && c[2] === true),
    JSON.stringify(remote.calls))
  check('the expansion is locally visible immediately',
    model.expansions.getSnapshot()[projectId] === true,
    JSON.stringify(model.expansions.getSnapshot()))

  await model.setExpanded(projectId, false)
  check('an explicit false is stored as false',
    model.expansions.getSnapshot()[projectId] === false,
    JSON.stringify(model.expansions.getSnapshot()))

  // The snapshot must change identity on a real change, or the browser's
  // selector would not re-render.
  const settled = model.expansions.getSnapshot()
  await model.setExpanded(projectId, false)
  check('recording the same state again is a no-op',
    model.expansions.getSnapshot() === settled)

  // A reconnect baseline carries it, which is what makes it survive a restart.
  await model.start()
  check('the Host projection carries the expansion',
    model.expansions.getSnapshot()[projectId] === false,
    JSON.stringify(model.expansions.getSnapshot()))
  stop()
}

// 13. An optimistic write reverts when the Host refuses it, so a refusal does
//     not leave the row showing a state that was never stored.
{
  const { model, stop } = await started({ failOn: 'setExpanded' })
  await model.create('abc')
  await model.start()
  const projectId = model.list()[0].projectId

  let threw = false
  try {
    await model.setExpanded(projectId, true)
  } catch {
    threw = true
  }
  check('a refused expansion write rejects', threw)
  check('and the optimistic value was rolled back',
    model.expansions.getSnapshot()[projectId] === undefined,
    JSON.stringify(model.expansions.getSnapshot()))
  stop()
}

// 14. Deleting a project takes its expansion with it, so nothing unreachable
//     lingers in the map.
{
  const { model, stop } = await started()
  await model.create('gone')
  await model.start()
  const projectId = model.list()[0].projectId
  await model.setExpanded(projectId, true)
  await model.remove(projectId)
  await model.start()
  check('the deleted project leaves no expansion behind',
    model.expansions.getSnapshot()[projectId] === undefined,
    JSON.stringify(model.expansions.getSnapshot()))
  stop()
}

await tick()
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
