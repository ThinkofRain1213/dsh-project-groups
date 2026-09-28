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
const { clientExpansions, clientGrouping, clientNewSessionTarget, clientOrders, installProjectModel } = await import('../src/client/grouping.ts')

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
 *
 * Two hooks exist for the optimistic-placement tests, which need to observe the
 * window *between* a local write and the Host's frame:
 *
 *  - `holdAssign` names the Sessions whose `assign`/`unassign` parks until
 *    `releasePlace`, so a test can inspect the in-flight state, push frames into
 *    it, and order two writes against each other;
 *  - `deliver` pushes one baseline of an arbitrary projection, which is how a
 *    stale frame (one produced before the write) is reproduced.
 */
function fakeRemote({ failOn, holdAssign = [], refuseAssignFor } = {}) {
  const state = { projects: [], assignments: {}, expansions: {}, orders: {}, newSessionTarget: 'ungrouped' }
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
  // Hoisted out of `follow` so `deliver` can push a frame the test chose, rather
  // than only the ones a landed write produces.
  const queue = [{ type: 'baseline', value: structuredClone(state) }]
  let wake
  const push = (value) => {
    queue.push({ type: 'baseline', value: structuredClone(value) })
    const pending = wake
    wake = undefined
    pending?.()
  }
  const landed = () => { for (const notify of [...watchers]) notify() }
  // Resolvers for held placements, released by the test.
  let releasePlace = []
  return {
    state,
    calls,
    /** Push one baseline of an arbitrary (possibly stale) projection. */
    deliver: push,
    /** Let every held `assign`/`unassign` proceed. */
    releasePlace: () => { const held = releasePlace; releasePlace = []; for (const resolve of held) resolve() },
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
      delete state.orders[projectId]
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
    async setOrders({ orders }) {
      calls.push(['setOrders', orders])
      const refused = guard('setOrders')
      if (refused !== undefined) return refused
      // Whole-map replace, like the Host: an omitted project loses its record,
      // and an unknown project id is dropped rather than refused.
      const known = new Set(state.projects.map(p => p.projectId))
      state.orders = Object.fromEntries(
        Object.entries(orders).filter(([id]) => known.has(id)).map(([id, ids]) => [id, [...ids]]),
      )
      landed()
      return ok({ orders: state.orders })
    },
    async setNewSessionTarget({ target }) {
      calls.push(['setNewSessionTarget', target])
      const refused = guard('setNewSessionTarget')
      if (refused !== undefined) return refused
      state.newSessionTarget = target
      landed()
      return ok({ target })
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
      // Held first, refused after release: a test needs a write that is still
      // *in flight* when a second Session's write lands, so the rollback has
      // something concurrent to preserve.
      if (holdAssign.includes(sessionId)) await new Promise(resolve => { releasePlace.push(resolve) })
      // Refuse one named Session, so a test can let a *different* Session's write
      // succeed around a refused one without turning `assign` off wholesale.
      if (refuseAssignFor !== undefined && refuseAssignFor.includes(sessionId)) {
        return { ok: false, error: { message: 'assign refused by host' } }
      }
      state.assignments[sessionId] = projectId
      landed()
      return ok({ sessionId, projectId })
    },
    async unassign({ sessionId }) {
      calls.push(['unassign', sessionId])
      const refused = guard('unassign')
      if (refused !== undefined) return refused
      if (holdAssign.includes(sessionId)) await new Promise(resolve => { releasePlace.push(resolve) })
      const removed = Object.hasOwn(state.assignments, sessionId)
      delete state.assignments[sessionId]
      landed()
      return ok({ sessionId, removed })
    },
    follow(signal) {
      // An opening baseline, then one fresh projection per landed write — the
      // shape the real Host's `follow` has. The queue lives outside so `deliver`
      // can add a frame the test chose.
      const notify = () => { push(state) }
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

// 10. Early subscribers on every seat are woken when the model arrives.
//
//     The browser registers its hooks during the vendored `apply`, which can
//     precede the Remote baseline, so the observables must hold their early
//     listeners and hand them to the model on install. This is the one place the
//     install happens, so every seat is exercised together — a later install
//     would replace the module-level model and leave a subscriber bound to the
//     old one.
{
  const seenGroups = []
  const seenExpansions = []
  const seenTargets = []
  const unsubscribeGroups = clientGrouping.subscribe(() => { seenGroups.push(clientGrouping.getSnapshot().length) })
  const unsubscribeExpansions = clientExpansions.subscribe(() => { seenExpansions.push(clientExpansions.getSnapshot()) })
  // The settings card takes this seat, and it can register before the baseline
  // too — so it gets the same early-subscriber treatment.
  const unsubscribeTargets = clientNewSessionTarget.subscribe(() => { seenTargets.push(clientNewSessionTarget.getSnapshot()) })
  check('a snapshot read before install is the empty override',
    clientGrouping.getSnapshot().length === 0)
  check('and the expansion seat reads empty before install',
    Object.keys(clientExpansions.getSnapshot()).length === 0)
  check('and the destination seat reads the Host default before install',
    clientNewSessionTarget.getSnapshot() === 'ungrouped',
    clientNewSessionTarget.getSnapshot())

  const { model, stop } = await started()
  await model.create('early')
  await model.start()
  const projectId = model.list()[0].projectId
  await model.setExpanded(projectId, true)
  // A stored destination the model will carry, so the wake-up is a real change
  // rather than a repeat of the default the early reader already saw.
  await model.setNewSessionTarget('recent')
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
  check('installing the model wakes an early destination subscriber', seenTargets.length > 0,
    `notified ${seenTargets.length}x`)
  check('and its next read sees the stored destination',
    clientNewSessionTarget.getSnapshot() === 'recent',
    clientNewSessionTarget.getSnapshot())

  // A later change reaches the seat that was subscribed before install, not just
  // the listener count the install produced.
  const before = seenTargets.length
  await model.setNewSessionTarget('current')
  check('and the early subscriber follows later changes',
    seenTargets.length > before && clientNewSessionTarget.getSnapshot() === 'current',
    JSON.stringify({ before, after: seenTargets.length, value: clientNewSessionTarget.getSnapshot() }))

  unsubscribeGroups()
  unsubscribeExpansions()
  unsubscribeTargets()
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

// 16. Manual order: the plugin's own state, whole-map replace, and the
//     absence-means-recency rule the ordering pipeline depends on.
{
  const { model, remote, stop } = await started()
  await model.create('a')
  await model.start()
  const projectId = model.list()[0].projectId

  check('a fresh project has no order record',
    model.orders.getSnapshot()[projectId] === undefined,
    JSON.stringify(model.orders.getSnapshot()))

  await model.setOrders({ [projectId]: ['s2', 's1'] })
  check('the write reached the namespace',
    remote.calls.some(c => c[0] === 'setOrders'), JSON.stringify(remote.calls.map(c => c[0])))
  check('the order is locally visible immediately',
    model.orders.getSnapshot()[projectId]?.join(',') === 's2,s1',
    JSON.stringify(model.orders.getSnapshot()))

  // The Host projection is what makes it survive a reconnect.
  await model.start()
  check('the Host projection carries the order',
    model.orders.getSnapshot()[projectId]?.join(',') === 's2,s1',
    JSON.stringify(model.orders.getSnapshot()))

  // Whole-map semantics: omitting the project discards its record, which is how
  // recency mode means "no manual order".
  await model.setOrders({})
  check('an empty map discards the record',
    model.orders.getSnapshot()[projectId] === undefined,
    JSON.stringify(model.orders.getSnapshot()))
  await model.start()
  check('and the discard survives a re-read',
    model.orders.getSnapshot()[projectId] === undefined,
    JSON.stringify(model.orders.getSnapshot()))
  stop()
}

// 17. A reordered list is a real change, an identical one is not — the snapshot
//     identity is what the browser's selector compares.
{
  const { model, stop } = await started()
  await model.create('a')
  await model.start()
  const projectId = model.list()[0].projectId
  await model.setOrders({ [projectId]: ['s1', 's2'] })
  const settled = model.orders.getSnapshot()

  await model.setOrders({ [projectId]: ['s1', 's2'] })
  check('an identical order does not notify', model.orders.getSnapshot() === settled)

  await model.setOrders({ [projectId]: ['s2', 's1'] })
  check('a reordered list yields a new snapshot', model.orders.getSnapshot() !== settled)
  check('and carries the new order',
    model.orders.getSnapshot()[projectId]?.join(',') === 's2,s1',
    JSON.stringify(model.orders.getSnapshot()))
  stop()
}

// 18. A refused order write reverts, so the row does not keep showing a position
//     the Host never stored.
{
  const { model, stop } = await started({ failOn: 'setOrders' })
  await model.create('a')
  await model.start()
  const projectId = model.list()[0].projectId
  let threw = false
  try {
    await model.setOrders({ [projectId]: ['s2', 's1'] })
  } catch {
    threw = true
  }
  check('a refused order write rejects', threw)
  check('and the optimistic order was rolled back',
    model.orders.getSnapshot()[projectId] === undefined,
    JSON.stringify(model.orders.getSnapshot()))
  stop()
}

// 19. Deleting a project takes its order with it.
{
  const { model, stop } = await started()
  await model.create('gone')
  await model.start()
  const projectId = model.list()[0].projectId
  await model.setOrders({ [projectId]: ['s1'] })
  await model.remove(projectId)
  await model.start()
  check('the deleted project leaves no order behind',
    model.orders.getSnapshot()[projectId] === undefined,
    JSON.stringify(model.orders.getSnapshot()))
  stop()
}

// 20. The orders seat answers independently of the other two, and a baseline
//     missing the field degrades to "no manual order" rather than throwing in
//     the sidebar's render path.
{
  const { model, stop } = await started()
  await model.create('a')
  await model.start()
  check('an empty orders record is the pre-install snapshot',
    Object.keys(clientOrders.getSnapshot()).length === 0,
    JSON.stringify(clientOrders.getSnapshot()))

  // A Host that omits `orders` must not take the sidebar down with it. `follow`
  // yields nothing so the model's stream loop ends quietly instead of logging a
  // carrier error that would read like a real failure in the output.
  const legacy = new ProjectModel({
    baseline: async () => ({ ok: true, value: { projects: [], projectIds: [], assignments: {}, expansions: {} } }),
    create: async () => ({ ok: true, value: {} }),
    rename: async () => ({ ok: true, value: {} }),
    delete: async () => ({ ok: true, value: {} }),
    reorder: async () => ({ ok: true, value: {} }),
    assign: async () => ({ ok: true, value: {} }),
    unassign: async () => ({ ok: true, value: {} }),
    setExpanded: async () => ({ ok: true, value: {} }),
    setOrders: async () => ({ ok: true, value: {} }),
    setNewSessionTarget: async () => ({ ok: true, value: {} }),
    follow: () => (async function* () {})(),
  })
  let survived = true
  try {
    await legacy.start()
  } catch {
    survived = false
  }
  check('a baseline without an orders field does not throw', survived)
  check('and reads as no manual order', Object.keys(legacy.orders.getSnapshot()).length === 0)
  check('and a baseline without a destination reads as Ungrouped',
    legacy.target() === 'ungrouped', String(legacy.target()))
  stop()
}

// 21. The New Session destination: stored, reported, and optimistic.
{
  const { model, remote, stop } = await started()
  await model.create('a')
  await model.start()
  check('a fresh model starts at Ungrouped', model.target() === 'ungrouped', String(model.target()))

  await model.setNewSessionTarget('recent')
  check('the write reached the namespace',
    remote.calls.some(c => c[0] === 'setNewSessionTarget'), JSON.stringify(remote.calls.map(c => c[0])))
  check('the choice is locally visible immediately', model.target() === 'recent', String(model.target()))

  await model.start()
  check('and the Host projection carries it', model.target() === 'recent', String(model.target()))

  // The observable the settings card will read. Counted rather than pinned to a
  // number: the model notifies once for the optimistic write and again when the
  // Host's `follow` frame lands, and that is the intended shape — the assertion
  // that matters is that a change notifies and an identical value does not.
  let notified = 0
  const unsubscribe = model.newSessionTarget$.subscribe(() => { notified += 1 })
  await model.setNewSessionTarget('current')
  const afterChange = notified
  check('the observable notifies on a change', afterChange > 0, String(afterChange))
  check('and answers the new value', model.newSessionTarget$.getSnapshot() === 'current',
    String(model.newSessionTarget$.getSnapshot()))
  await model.setNewSessionTarget('current')
  check('an identical choice does not notify again', notified === afterChange, String(notified))
  unsubscribe()
  stop()
}

// 22. A refused destination write reverts, so the card never shows a choice the
//     Host did not store.
{
  const { model, stop } = await started({ failOn: 'setNewSessionTarget' })
  await model.create('a')
  await model.start()
  let threw = false
  try {
    await model.setNewSessionTarget('recent')
  } catch {
    threw = true
  }
  check('a refused destination write rejects', threw)
  check('and the optimistic choice was rolled back', model.target() === 'ungrouped', String(model.target()))
  stop()
}

// 23. `resolveTarget` — the policy itself, as a pure function.
{
  const { resolveTarget } = await import('../src/client/target.ts')
  const ownerOf = id => (id === 'in-project' ? 'p1' : undefined)
  const recent = () => 'p2'

  check('ungrouped resolves to no project',
    resolveTarget('ungrouped', 'in-project', ownerOf, recent) === undefined)
  check('current follows the Session the user is looking at',
    resolveTarget('current', 'in-project', ownerOf, recent) === 'p1')
  check('current in Ungrouped resolves to no project',
    resolveTarget('current', 'loose', ownerOf, recent) === undefined)
  // Archiving the current Session clears the selection; the Host answers that
  // state with a picker rather than a guess, and Ungrouped is our legal default.
  check('current with no current Session resolves to no project',
    resolveTarget('current', undefined, ownerOf, recent) === undefined)
  check('recent follows the most recently active project',
    resolveTarget('recent', 'in-project', ownerOf, recent) === 'p2')
  check('recent ignores the current Session',
    resolveTarget('recent', 'in-project', ownerOf, () => undefined) === undefined)
}

// 24. `recentDestination` — mirrors the Host's own `recentWorkspace` edge rules,
//     plus the third candidate the Host has no room for: Ungrouped.
//
//     The Host's function returns a Workspace id and every Session there belongs
//     to one, so it has no "no container" case. Here Ungrouped is a real
//     destination: when the last Session the user worked in belongs to no
//     project, `recent` must follow it there rather than falling back to whichever
//     project happens to be newest.
{
  const { recentDestination } = await import('../src/client/target.ts')
  const project = (projectId, createdAt) => ({
    projectId, title: projectId, docPath: '', createdAt, updatedAt: createdAt,
  })
  const members = mapping => id => mapping[id] ?? []

  // Most recent activity wins, regardless of display order. Times are epoch
  // milliseconds, the same unit the Session summaries carry — a small literal
  // here would lose to any project's `createdAt` and the assertion would be
  // measuring the wrong thing.
  const early = Date.parse('2026-01-01T00:00:00Z')
  const late = Date.parse('2026-02-01T00:00:00Z')
  check('the project with the latest Session wins',
    recentDestination(
      [project('p1', '2026-01-01T00:00:00Z'), project('p2', '2026-01-01T00:00:00Z')],
      { s1: early, s2: late },
      members({ p1: ['s1'], p2: ['s2'] }),
      [],
    ) === 'p2')

  // An empty project falls back to its own createdAt, or it could never be picked.
  check('an empty project falls back to its createdAt',
    recentDestination(
      [project('p1', '2026-01-01T00:00:00Z'), project('p2', '2026-06-01T00:00:00Z')],
      {},
      members({}),
      [],
    ) === 'p2')

  // Strict `>` keeps the earlier project on a tie, matching the Host.
  check('a tie keeps the earlier project in display order',
    recentDestination(
      [project('p1', '2026-06-01T00:00:00Z'), project('p2', '2026-06-01T00:00:00Z')],
      {},
      members({}),
      [],
    ) === 'p1')

  check('no projects and nothing loose resolves to nothing',
    recentDestination([], {}, members({}), []) === undefined)

  // A Session id with no reported time must not drag its project down: p1 has one
  // live Session and one unknown, p2 has only unknown, so p1 wins on the live one.
  check('an unknown Session time does not drag its project down',
    recentDestination(
      [project('p1', '2026-01-01T00:00:00Z'), project('p2', '2026-01-01T00:00:00Z')],
      { s1: late },
      members({ p1: ['s1', 'gone'], p2: ['also-gone'] }),
      [],
    ) === 'p1')

  // The reported defect: the user's last Session was in no project, and `recent`
  // sent the New Session to the newest *project* instead of to Ungrouped.
  check('a looser Session newer than every project resolves to Ungrouped',
    recentDestination(
      [project('p1', '2026-01-01T00:00:00Z'), project('p2', '2026-01-01T00:00:00Z')],
      { s1: early, loose1: late },
      members({ p1: ['s1'], p2: [] }),
      ['loose1'],
    ) === undefined,
    String(recentDestination(
      [project('p1', '2026-01-01T00:00:00Z'), project('p2', '2026-01-01T00:00:00Z')],
      { s1: early, loose1: late },
      members({ p1: ['s1'], p2: [] }),
      ['loose1'],
    )))

  // …but a project that is genuinely newer still wins, or Ungrouped would swallow
  // every answer the moment anything was loose.
  check('a project newer than every loose Session still wins',
    recentDestination(
      [project('p1', '2026-01-01T00:00:00Z'), project('p2', '2026-01-01T00:00:00Z')],
      { s2: late, loose1: early },
      members({ p1: [], p2: ['s2'] }),
      ['loose1'],
    ) === 'p2')

  // Ungrouped has no `createdAt`, so an empty Ungrouped bucket cannot win by the
  // fallback that lets a freshly created project be chosen.
  check('Ungrouped cannot win on its own with no loose activity',
    recentDestination(
      [project('p1', '2026-01-01T00:00:00Z')],
      {},
      members({}),
      ['blank-row'],
    ) === 'p1')

  // A tie goes to the project, because Ungrouped is considered last and the
  // comparison is strict — the Host's display-order rule, not a new preference.
  check('a tie between Ungrouped and a project keeps the project',
    recentDestination(
      [project('p1', '2026-01-01T00:00:00Z')],
      { s1: late, loose1: late },
      members({ p1: ['s1'] }),
      ['loose1'],
    ) === 'p1')
}

// 25. Placement is optimistic, and survives the frames that predate it.
//
//     The reported defect: with a New Session already filed under A, pressing B's
//     ＋ rendered the row under A first and only then glided it to B — because the
//     reused blank Session carries its previous assignment, and a write that waits
//     for the Host renders that intermediate state for one frame. The fix writes
//     locally before calling the Host, so the first render already shows B.
//
//     Each assertion guards a specific way that fix can fail silently.
{
  // ── 25a. The write lands locally, and the derived groups follow it. ──
  //
  // Clearing the derived-grouping cache is the quietest failure mode in the whole
  // change: the assignment map would be correct while the sidebar kept rendering
  // the old groups, with no error anywhere.
  {
    const { model, remote, stop } = await started({ holdAssign: ['s1'] })
    await model.create('A')
    const projectId = model.list()[0].projectId

    // Deliberately not awaited: the point is that state moved before the Host
    // answered. The held write is released after the assertions.
    const pending = model.assign('s1', projectId)
    check('an assignment lands in the snapshot before the Host answers',
      model.grouping.getSnapshot().find(source => source.key === projectId)?.sessionIds.includes('s1') === true,
      JSON.stringify(model.grouping.getSnapshot()))
    const groups = groupsOf(model, [projectId])
    check('and the derived groups move the Session in the same beat',
      groups.find(group => group.key === projectId)?.sessionCount === 1,
      groups.map(g => `${g.key}:${g.sessionCount}`).join(' '))
    check('while Ungrouped no longer holds it',
      groups.find(group => group.key === UNGROUPED_KEY)?.sessionCount === 2,
      groups.map(g => `${g.key}:${g.sessionCount}`).join(' '))

    remote.releasePlace()
    await pending.catch(() => {})
    await tick()
    stop()
  }

  // ── 25b. Re-filing where the Session already is notifies nobody. ──
  //
  // This is what keeps the *same* project's ＋ a fade: with no state change there
  // is no notification, so the row's key is new in the next commit and the list
  // fades it instead of gliding it. It also avoids a pointless Host round trip.
  {
    const { model, remote, stop } = await started()
    await model.create('A')
    const projectId = model.list()[0].projectId
    await model.assign('s1', projectId)
    await tick()
    let notified = 0
    const unsubscribe = model.grouping.subscribe(() => { notified += 1 })
    await model.assign('s1', projectId)
    await tick()
    check('re-filing a Session where it already is notifies nobody', notified === 0, String(notified))
    check('and writes nothing to the Host',
      remote.calls.filter(([name]) => name === 'assign').length === 1,
      JSON.stringify(remote.calls.filter(([name]) => name === 'assign')))
    unsubscribe()
    stop()
  }

  // ── 25c. A refusal rolls back that Session, and leaves a concurrent one alone.
  //
  // s1 is held then refused; while it is still in flight s2 lands successfully.
  // Reverting s1 against a whole-map snapshot would discard s2's legitimate
  // placement — the unit of this write is one Session, so the rollback must be too.
  {
    const { model, remote, stop } = await started({ holdAssign: ['s1'], refuseAssignFor: ['s1'] })
    await model.create('A')
    const projectId = model.list()[0].projectId

    // In flight, not yet refused: the fake refuses only after the release below.
    const refused = model.assign('s1', projectId).then(
      () => 'resolved', () => 'rejected',
    )
    await tick()
    // s2 lands while s1's write is still pending.
    await model.assign('s2', projectId)
    await tick()
    check('a concurrent placement is visible before the first write settles',
      model.grouping.getSnapshot().find(source => source.key === projectId)?.sessionIds.includes('s2') === true,
      JSON.stringify(model.grouping.getSnapshot()))

    remote.releasePlace()
    check('a refused assignment rejects', await refused === 'rejected', await refused)
    await tick()

    const members = model.grouping.getSnapshot().find(source => source.key === projectId)?.sessionIds ?? []
    check('a refusal rolls that Session back to no owner',
      !members.includes('s1'), JSON.stringify(members))
    check('and leaves a concurrent placement of another Session intact',
      members.includes('s2'), JSON.stringify(members))
    stop()
  }

  // ── 25d. A frame that predates the write does not undo it. ──
  //
  // The Host re-projects after every landed write, and one of those baselines can
  // be produced *before* our optimistic write — carrying the previous owner.
  // Accepting it would revert the row for one render, which is the whole bug.
  {
    const { model, remote, stop } = await started({ holdAssign: ['s1'] })
    await model.create('A')
    const projectId = model.list()[0].projectId
    const pending = model.assign('s1', projectId)

    // A stale projection: the Host has not applied the write yet.
    remote.deliver({ projects: remote.state.projects, assignments: {}, expansions: {}, orders: {}, newSessionTarget: 'ungrouped' })
    await tick()
    check('a baseline produced before the write does not undo it',
      model.grouping.getSnapshot().find(source => source.key === projectId)?.sessionIds.includes('s1') === true,
      JSON.stringify(model.grouping.getSnapshot()))

    remote.releasePlace()
    await pending.catch(() => {})
    await tick()
    stop()
  }

  // ── 25e. The overlay retires once the Host echoes the write. ──
  //
  // Otherwise a successful-but-un-echoed write would pin that Session's owner
  // locally forever, and later Host values would never get through.
  {
    const { model, remote, stop } = await started({ holdAssign: ['s1'] })
    await model.create('A')
    await model.create('B')
    const [a, b] = model.list().map(project => project.projectId)
    const pending = model.assign('s1', a)
    // A stale frame while the write is still held: the overlay must hold it off.
    remote.deliver({ projects: remote.state.projects, assignments: {}, expansions: {}, orders: {}, newSessionTarget: 'ungrouped' })
    await tick()
    remote.releasePlace()
    await pending.catch(() => {})
    await tick()
    check('the write itself is not pinned once it lands',
      model.grouping.getSnapshot().find(source => source.key === a)?.sessionIds.includes('s1') === true,
      JSON.stringify(model.grouping.getSnapshot()))
    // With the overlay retired, a later Host value wins again. If the entry had
    // leaked, this authoritative move to B would be silently ignored.
    remote.deliver({ projects: remote.state.projects, assignments: { s1: b }, expansions: {}, orders: {}, newSessionTarget: 'ungrouped' })
    await tick()
    check('and the overlay retired, so a later Host value takes effect',
      model.grouping.getSnapshot().find(source => source.key === b)?.sessionIds.includes('s1') === true,
      JSON.stringify(model.grouping.getSnapshot()))
    stop()
  }

  // ── 25f. Unassigning removes the key rather than storing `undefined`. ──
  //
  // Absence is what Ungrouped means, and both the equality check and the grouping
  // derivation walk `Object.keys` — a present key holding `undefined` would count
  // as an owner and render the row under a project that no longer claims it.
  {
    const { model, stop } = await started()
    await model.create('A')
    const projectId = model.list()[0].projectId
    await model.assign('s1', projectId)
    await tick()
    await model.unassign('s1')
    await tick()
    const groups = groupsOf(model, [projectId])
    check('unassigning drops the Session from the project',
      groups.find(group => group.key === projectId)?.sessionCount === 0,
      groups.map(g => `${g.key}:${g.sessionCount}`).join(' '))
    check('and the Session is back under Ungrouped',
      groups.find(group => group.key === UNGROUPED_KEY)?.sessionCount === 3,
      groups.map(g => `${g.key}:${g.sessionCount}`).join(' '))
    // The map itself must not keep the key: `Object.keys` drives both the
    // equality check and the grouping derivation.
    const sources = model.grouping.getSnapshot()
    check('and no group claims it',
      sources.every(source => !source.sessionIds.includes('s1')),
      JSON.stringify(sources))
    stop()
  }
}

await tick()
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
