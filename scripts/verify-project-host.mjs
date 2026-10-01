/**
 * Behaviour test for the Host half's project registry.
 *
 * Drives the real `ProjectController` against a real domain facility over the
 * in-memory JSON backend, so the assertions cover what the Client would actually
 * observe: the projection, the ordering, the assignment map, and that a delete
 * takes its assignments with it.
 *
 * The Remote transport itself is not simulated — `@Remote` only marks the
 * prototype, and the methods are plain async functions, so calling them directly
 * is the same code path the Gateway reaches after decoding. The wire round-trip
 * was verified against a live Host: `projectGroups/*` answered over `/api` and
 * the domain landed in `$DSH_HOME/storages/project_groups.json`.
 */
import { register } from 'node:module'

register('./lib/ts-loader.mjs', import.meta.url)

const { Context } = await import('@deepseek-ai/cordis')
const { DomainFacility, descriptorOf } = await import('@deepseek-ai/dsh-storage-domain')
const { ProjectController } = await import('../src/index.ts')
const { PROJECT_DOMAIN_NAME, projectDomainSpec } = await import('../src/spec.ts')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** A storage backend that answers the domain facility from memory. */
function memoryBackend() {
  const units = new Map()
  return {
    units,
    /** The `kv` facet the facility opens a domain through. */
    kv: {
      async open(descriptor) {
        const key = descriptor.name
        let state = units.get(key)
        if (state === undefined) {
          state = { global: null, tables: {} }
          units.set(key, state)
        }
        return {
          async loadAll() {
            return {
              global: state.global,
              tables: Object.fromEntries(
                Object.entries(state.tables).map(([table, rows]) => [table, { ...rows }]),
              ),
            }
          },
          async setGlobal(value) { state.global = value },
          async putRecord(table, recordKey, value) {
            state.tables[table] = { ...(state.tables[table] ?? {}), [recordKey]: value }
          },
          async deleteRecord(table, recordKey) {
            if (state.tables[table] !== undefined) delete state.tables[table][recordKey]
          },
          async close() {},
        }
      },
    },
  }
}

/**
 * Build a Host context whose `storageDomain` is a real facility over the given
 * backend. One context per controller: the service key is per-Context, so a
 * second controller in the same one is refused.
 */
function benchContext(backend) {
  const ctx = new Context()
  ctx.provide('storage', { backend: { get: () => backend } })
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'memory' }))
  return ctx
}

/**
 * Build a Host context over a fresh backend, plus the controller under test.
 */
function bench() {
  const backend = memoryBackend()
  return { ctx: benchContext(backend), controller: new ProjectController(benchContext(backend)), backend }
}

// 1. A fresh registry is empty and reports itself so.
{
  const { controller } = bench()
  const baseline = await controller.baseline()
  check('a fresh registry has no projects', baseline.projects.length === 0)
  check('a fresh registry carries an empty order', baseline.projectIds.length === 0)
  check('a fresh registry carries no assignments', Object.keys(baseline.assignments).length === 0)
}

// 2. Create prepends — newest first, matching the Host's Workspace registry —
//    and lands durably.
{
  const { controller, backend } = bench()
  const first = await controller.create({ title: '项目一' })
  const second = await controller.create({ title: 'second' })
  check('create returns a titled project', first.project.title === '项目一')
  check('create generates a distinct id', first.project.projectId !== second.project.projectId)
  check('create records no document yet', first.project.docPath === '')

  const baseline = await controller.baseline()
  // Newest first: `packages/workspace/workspace/src/index.ts` stores
  // `workspaceIds: [id, ...state.workspaceIds]`, and a new row should appear where
  // the user is looking rather than below however many rows already exist.
  check('the newest project is first',
    baseline.projects.map(p => p.title).join(',') === 'second,项目一',
    baseline.projects.map(p => p.title).join(','))
  check('and the order array agrees',
    baseline.projectIds.join(',') === `${second.project.projectId},${first.project.projectId}`,
    baseline.projectIds.join(','))
  check('the durable unit was opened', backend.units.has(PROJECT_DOMAIN_NAME),
    [...backend.units.keys()].join(','))
  check('the record landed in the table',
    Object.keys(backend.units.get(PROJECT_DOMAIN_NAME).tables.projects ?? {}).length === 2)
}

// 2b. Prepend must not disturb an order the user has rearranged: the new row
//     goes to the front, and everything else keeps its relative position.
{
  const { controller } = bench()
  const a = (await controller.create({ title: 'a' })).project.projectId
  const b = (await controller.create({ title: 'b' })).project.projectId
  const c = (await controller.create({ title: 'c' })).project.projectId
  check('three creates are newest-first', (await controller.baseline()).projectIds.join(',') === `${c},${b},${a}`,
    (await controller.baseline()).projectIds.join(','))

  // Rearrange, then create: the existing order is preserved behind the new row.
  await controller.reorder({ projectId: a, beforeId: c })
  check('a manual order is respected', (await controller.baseline()).projectIds.join(',') === `${a},${c},${b}`,
    (await controller.baseline()).projectIds.join(','))
  const d = (await controller.create({ title: 'd' })).project.projectId
  check('a later create still goes to the very front',
    (await controller.baseline()).projectIds.join(',') === `${d},${a},${c},${b}`,
    (await controller.baseline()).projectIds.join(','))
}

// 3. Titles are trimmed, and a blank one is refused.
{
  const { controller } = bench()
  const created = await controller.create({ title: '  spaced  ' })
  check('create trims the title', created.project.title === 'spaced', created.project.title)
  let message = ''
  try {
    await controller.create({ title: '   ' })
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('create refuses a blank title', message.includes('title is required'), message)
}

// 4. Rename updates in place and rejects an unknown id.
{
  const { controller } = bench()
  const { project } = await controller.create({ title: 'before' })
  const renamed = await controller.rename({ projectId: project.projectId, title: 'after' })
  check('rename returns the new title', renamed.project.title === 'after')
  check('rename keeps the id', renamed.project.projectId === project.projectId)
  check('rename keeps the creation instant', renamed.project.createdAt === project.createdAt)
  check('rename advances updatedAt', renamed.project.updatedAt >= project.updatedAt)
  check('the baseline reflects the rename',
    (await controller.baseline()).projects[0].title === 'after')

  let message = ''
  try {
    await controller.rename({ projectId: 'nope', title: 'x' })
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('rename refuses an unknown project', message.includes('unknown project'), message)
}

// 4b. Titles are unique — the rule `dsh-client-ui-workspace` applies to a Workspace rename
//     (`workspaces.some(w => w.workspaceId !== renameTarget.workspaceId && w.title ===
//     renameTrimmed)`), enforced here too because the Remote is reachable without its dialog.
{
  const { controller } = bench()
  const { project: first } = await controller.create({ title: 'shared' })

  let message = ''
  try {
    await controller.create({ title: 'shared' })
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('create refuses a duplicate title', message.includes('already exists'), message)
  check('the refused create stored nothing',
    (await controller.baseline()).projects.length === 1,
    String((await controller.baseline()).projects.length))

  const { project: other } = await controller.create({ title: 'other' })
  message = ''
  try {
    await controller.rename({ projectId: other.projectId, title: 'shared' })
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('rename refuses a title another project holds', message.includes('already exists'), message)
  check('the refused rename kept the old title',
    (await controller.baseline()).projects.find(p => p.projectId === other.projectId).title === 'other')

  // Self-exclusion. Renaming a project to the name it already has must not count as a conflict —
  // it is a no-op the dialog disables on its own, and matching on the title rather than the id
  // would refuse it and leave the row unable to keep its own name.
  const kept = await controller.rename({ projectId: first.projectId, title: 'shared' })
  check('rename to its own current title is allowed', kept.project.title === 'shared')

  // Whitespace is trimmed before storage, so these two are the same name.
  message = ''
  try {
    await controller.create({ title: '  shared  ' })
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('a padded duplicate is still a duplicate', message.includes('already exists'), message)

  // Case-sensitive, exactly like the dialog's `===`: being stricter here would refuse a name its
  // own UI accepted.
  const cased = await controller.create({ title: 'SHARED' })
  check('a differently cased title is free', cased.project.title === 'SHARED')

  // Deleting releases the name.
  await controller.remove({ projectId: first.projectId })
  const reused = await controller.create({ title: 'shared' })
  check('a deleted title becomes available again', reused.project.title === 'shared')
}

// 5. Assign replaces, so a Session can never belong to two projects.
{
  const { controller } = bench()
  const a = (await controller.create({ title: 'a' })).project.projectId
  const b = (await controller.create({ title: 'b' })).project.projectId
  await controller.assign({ sessionId: 'session-1', projectId: a })
  check('assign records the owner', (await controller.baseline()).assignments['session-1'] === a)

  await controller.assign({ sessionId: 'session-1', projectId: b })
  const baseline = await controller.baseline()
  check('a second assign replaces rather than adds',
    baseline.assignments['session-1'] === b && Object.keys(baseline.assignments).length === 1,
    JSON.stringify(baseline.assignments))

  let message = ''
  try {
    await controller.assign({ sessionId: 'session-1', projectId: 'nope' })
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('assign refuses an unknown project', message.includes('unknown project'), message)
}

// 6. Unassign is idempotent and reports whether anything was removed.
{
  const { controller } = bench()
  const projectId = (await controller.create({ title: 'a' })).project.projectId
  await controller.assign({ sessionId: 'session-1', projectId })
  check('unassign removes an existing assignment',
    (await controller.unassign({ sessionId: 'session-1' })).removed === true)
  check('unassign of an absent assignment reports nothing removed',
    (await controller.unassign({ sessionId: 'session-1' })).removed === false)
}

// 7. Reorder moves in order, with an absent anchor appending.
{
  const { controller } = bench()
  const a = (await controller.create({ title: 'a' })).project.projectId
  const b = (await controller.create({ title: 'b' })).project.projectId
  const c = (await controller.create({ title: 'c' })).project.projectId
  // Create prepends, so the starting order is newest-first.
  check('creates start newest-first', (await controller.baseline()).projectIds.join(',') === `${c},${b},${a}`,
    (await controller.baseline()).projectIds.join(','))

  const moved = await controller.reorder({ projectId: a, beforeId: c })
  check('reorder places the project before its anchor',
    moved.projectIds.join(',') === `${a},${c},${b}`, moved.projectIds.join(','))
  check('the baseline follows the new order',
    (await controller.baseline()).projects.map(p => p.title).join(',') === 'a,c,b',
    (await controller.baseline()).projects.map(p => p.title).join(','))

  const appended = await controller.reorder({ projectId: c })
  check('an absent anchor appends',
    appended.projectIds.join(',') === `${a},${b},${c}`, appended.projectIds.join(','))

  let message = ''
  try {
    await controller.reorder({ projectId: 'nope' })
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('reorder refuses an unknown project', message.includes('unknown project'), message)
}

// 8. Delete removes the project and every assignment onto it, and nothing else.
{
  const { controller } = bench()
  const doomed = (await controller.create({ title: 'doomed' })).project.projectId
  const kept = (await controller.create({ title: 'kept' })).project.projectId
  await controller.assign({ sessionId: 'session-1', projectId: doomed })
  await controller.assign({ sessionId: 'session-2', projectId: doomed })
  await controller.assign({ sessionId: 'session-3', projectId: kept })

  await controller.remove({ projectId: doomed })
  const baseline = await controller.baseline()
  check('delete removes only the target project',
    baseline.projects.map(p => p.title).join(',') === 'kept', baseline.projects.map(p => p.title).join(','))
  check('delete drops the assignments onto it',
    Object.keys(baseline.assignments).join(',') === 'session-3',
    JSON.stringify(baseline.assignments))
  check('delete drops it from the order', baseline.projectIds.join(',') === kept)
  check('a Session whose project was deleted is simply unassigned',
    baseline.assignments['session-1'] === undefined)
}

// 9. A record whose id is absent from the order is not projected, and an
//    interrupted mutation is repaired on the next start.
//
//    The state has to be injected through the BACKEND, then observed by a
//    controller that opens over it. Assigning to `unit.global` alone would not
//    work: the facility reads `loadAll()` once, at open, and the live domain
//    keeps its own in-memory copy — so a later write to the backend's state
//    object is invisible to `baseline()`. That is how this test used to pass
//    against the old backfill without ever exercising it.
{
  const backend = memoryBackend()
  const first = new ProjectController(benchContext(backend))
  const created = await first.create({ title: 'orphan' })
  const orphanId = created.project.projectId

  // Rewind to the instant a crash would leave: the record is durable, the id was
  // never added to the order, and the marker names what was in flight.
  const unit = backend.units.get(PROJECT_DOMAIN_NAME)
  unit.global = { projectIds: [], pendingMutation: { operation: 'create', projectId: orphanId } }

  // A fresh controller over the same backend — the only way to see what a restart
  // sees, because the projection is derived at open.
  const restarted = new ProjectController(benchContext(backend))
  const baseline = await restarted.baseline()
  check('an interrupted create is not listed',
    baseline.projects.length === 0, baseline.projects.map(p => p.title).join(','))
  check('and the reported order is empty as well',
    baseline.projectIds.length === 0, baseline.projectIds.join(','))
  check('and recovery removed the interrupted record',
    Object.keys(unit.tables.projects).length === 0, JSON.stringify(unit.tables.projects))
  check('and cleared the marker',
    unit.global.pendingMutation === undefined, JSON.stringify(unit.global))
}

// 9b. A settled create leaves no marker or stray order entry behind. The positive
//     half of the guarantee: repair only matters if the normal path needs none.
{
  const { controller, backend } = bench()
  const created = await controller.create({ title: 'settled' })
  const unit = backend.units.get(PROJECT_DOMAIN_NAME)
  check('a settled create clears its marker', unit.global.pendingMutation === undefined,
    JSON.stringify(unit.global))
  check('and the order holds exactly that one id',
    (unit.global.projectIds ?? []).length === 1
    && unit.global.projectIds[0] === created.project.projectId,
    JSON.stringify(unit.global.projectIds))
  check('and the record is present',
    Object.keys(unit.tables.projects).length === 1, JSON.stringify(unit.tables.projects))
}

// 9c. Interrupted delete: the order write landed, the records did not. Recovery
//     must clear what a delete would have removed, including the assignment.
{
  const backend = memoryBackend()
  const first = new ProjectController(benchContext(backend))
  const created = await first.create({ title: 'doomed' })
  const doomedId = created.project.projectId

  const unit = backend.units.get(PROJECT_DOMAIN_NAME)
  unit.global = { projectIds: [], pendingMutation: { operation: 'delete', projectId: doomedId } }
  unit.tables.assignments = { 'session-1': { projectId: doomedId, assignedAt: 'now' } }

  const restarted = new ProjectController(benchContext(backend))
  const baseline = await restarted.baseline()
  check('an interrupted delete leaves no assignment behind',
    Object.keys(baseline.assignments).length === 0, JSON.stringify(baseline.assignments))
  check('and removed the record it named',
    Object.keys(unit.tables.projects).length === 0, JSON.stringify(unit.tables.projects))
  check('and cleared the marker',
    unit.global.pendingMutation === undefined, JSON.stringify(unit.global))
}

// 10. The domain descriptor this plugin hands the facility is the one it owns.
{
  const descriptor = descriptorOf(projectDomainSpec)
  check('the domain descriptor names the snake_case unit', descriptor.name === PROJECT_DOMAIN_NAME)
  check('the descriptor declares every table',
    descriptor.tables.slice().sort().join(',') === 'assignments,expansions,orders,projects',
    descriptor.tables.join(','))
  check('the descriptor declares a global', descriptor.hasGlobal === true)
  // Version 1 is load-bearing: a `single`-layout unit rejects a stored version
  // that differs from the spec's and has no migration step, so bumping it for an
  // added table would make every existing file unreadable. An added table needs
  // no bump — a unit predating it reads that table as empty.
  check('the descriptor version stays 1 so existing units still open',
    descriptor.version === 1, String(descriptor.version))
}

// 10b. Expansion state: recorded per project, distinguishable from absent, and
//      taken with the project when it is deleted.
{
  const { controller, backend } = bench()
  const kept = (await controller.create({ title: 'kept' })).project.projectId
  const doomed = (await controller.create({ title: 'doomed' })).project.projectId

  check('a project starts with no expansion record',
    (await controller.baseline()).expansions[kept] === undefined,
    JSON.stringify((await controller.baseline()).expansions))

  await controller.setExpanded({ projectId: kept, expanded: false })
  const collapsed = await controller.baseline()
  // `false` must survive as `false`: "folded deliberately" and "never touched"
  // are different states, and only the latter lets the browser auto-open.
  check('an explicit false is recorded as false, not dropped',
    collapsed.expansions[kept] === false, JSON.stringify(collapsed.expansions))

  await controller.setExpanded({ projectId: kept, expanded: true })
  check('an explicit true is recorded',
    (await controller.baseline()).expansions[kept] === true)

  await controller.setExpanded({ projectId: doomed, expanded: true })
  check('two projects hold separate records',
    Object.keys((await controller.baseline()).expansions).length === 2,
    JSON.stringify((await controller.baseline()).expansions))

  await controller.remove({ projectId: doomed })
  const afterDelete = await controller.baseline()
  check('deleting a project takes its expansion with it',
    afterDelete.expansions[doomed] === undefined && afterDelete.expansions[kept] === true,
    JSON.stringify(afterDelete.expansions))

  check('the durable unit holds the expansion table',
    Object.keys(backend.units.get(PROJECT_DOMAIN_NAME).tables.expansions ?? {}).length === 1,
    JSON.stringify(backend.units.get(PROJECT_DOMAIN_NAME).tables.expansions))

  let message = ''
  try {
    await controller.setExpanded({ projectId: 'nope', expanded: true })
    message = '(no throw)'
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check('setExpanded refuses an unknown project', message.includes('unknown project'), message)
}

// 11. Tearing the controller down and building a new one over the same medium
//     reads what the first one wrote — the restart path.
{
  const backend = memoryBackend()
  const first = new ProjectController(benchContext(backend))
  const created = await first.create({ title: 'persisted' })
  await first.assign({ sessionId: 'session-x', projectId: created.project.projectId })

  // A separate Context, as a restart has: the service key is per-Context, and a
  // second controller in the same one would (correctly) be refused.
  const second = new ProjectController(benchContext(backend))
  const baseline = await second.baseline()
  check('a rebuilt controller sees the stored project',
    baseline.projects.map(p => p.title).join(',') === 'persisted',
    baseline.projects.map(p => p.title).join(','))
  check('and the stored assignment',
    baseline.assignments['session-x'] === created.project.projectId,
    JSON.stringify(baseline.assignments))
  check('and the stored order', baseline.projectIds.join(',') === created.project.projectId)
}

// 12. Manual session order: whole-map replace, with recency expressed by absence.
{
  const { controller, backend } = bench()
  const a = (await controller.create({ title: 'a' })).project.projectId
  const b = (await controller.create({ title: 'b' })).project.projectId

  check('a project starts with no order record',
    (await controller.baseline()).orders[a] === undefined,
    JSON.stringify((await controller.baseline()).orders))

  await controller.setOrders({ orders: { [a]: ['s2', 's1'] } })
  let baseline = await controller.baseline()
  check('an order is recorded as given', baseline.orders[a]?.join(',') === 's2,s1',
    JSON.stringify(baseline.orders))
  check('a project left out of the map keeps no record', baseline.orders[b] === undefined)

  // The whole-map semantics: a project present in storage but absent from the
  // request loses its record. That is what makes recency mode mean "no manual
  // order" rather than "a stale one".
  await controller.setOrders({ orders: { [a]: ['s1', 's2'], [b]: ['s9'] } })
  baseline = await controller.baseline()
  check('a second project can be recorded alongside', baseline.orders[b]?.join(',') === 's9',
    JSON.stringify(baseline.orders))

  await controller.setOrders({ orders: { [a]: ['s1', 's2'] } })
  baseline = await controller.baseline()
  check('omitting a project DELETES its record (recency mode)',
    baseline.orders[b] === undefined, JSON.stringify(baseline.orders))

  await controller.setOrders({ orders: {} })
  baseline = await controller.baseline()
  check('an empty map discards every order',
    Object.keys(baseline.orders).length === 0, JSON.stringify(baseline.orders))

  check('the durable unit holds the order table',
    Object.keys(backend.units.get(PROJECT_DOMAIN_NAME).tables.orders ?? {}).length === 0,
    JSON.stringify(backend.units.get(PROJECT_DOMAIN_NAME).tables.orders))

  // A stale id can only come from a race with a delete; dropping it keeps the
  // race from failing the whole drag.
  await controller.setOrders({ orders: { [a]: ['s1'], 'project-that-was-deleted': ['s1'] } })
  baseline = await controller.baseline()
  check('an unknown project id is dropped, not refused',
    baseline.orders['project-that-was-deleted'] === undefined && baseline.orders[a]?.join(',') === 's1',
    JSON.stringify(baseline.orders))

  // Deleting a project takes its order with it.
  await controller.remove({ projectId: a })
  check('deleting a project takes its order with it',
    (await controller.baseline()).orders[a] === undefined)
}

// 13. setOrders diffs against storage, so an unchanged map writes nothing. Every
//     landed write makes the follower re-project, so this is what keeps a drag's
//     frame count proportional to the real change.
{
  const { controller, backend } = bench()
  const a = (await controller.create({ title: 'a' })).project.projectId
  await controller.setOrders({ orders: { [a]: ['s1', 's2'] } })

  const unit = backend.units.get(PROJECT_DOMAIN_NAME)
  const before = unit.tables.orders[a]
  // Rewriting the identical map must leave the stored object untouched.
  await controller.setOrders({ orders: { [a]: ['s1', 's2'] } })
  const after = backend.units.get(PROJECT_DOMAIN_NAME).tables.orders[a]
  check('an identical order is not rewritten', after === before,
    after === before ? undefined : 'the record object was replaced')

  await controller.setOrders({ orders: { [a]: ['s2', 's1'] } })
  check('a reordered list IS written',
    backend.units.get(PROJECT_DOMAIN_NAME).tables.orders[a].sessionIds.join(',') === 's2,s1',
    JSON.stringify(backend.units.get(PROJECT_DOMAIN_NAME).tables.orders[a]))
}

// 14. The New Session destination is stored on the global singleton, and writing
//     it must not disturb the project order that shares that singleton.
{
  const { controller, backend } = bench()
  const a = (await controller.create({ title: 'a' })).project.projectId
  const b = (await controller.create({ title: 'b' })).project.projectId

  check('a fresh registry defaults to Ungrouped',
    (await controller.baseline()).newSessionTarget === 'ungrouped',
    (await controller.baseline()).newSessionTarget)

  await controller.setNewSessionTarget({ target: 'recent' })
  check('the choice is reported by the baseline',
    (await controller.baseline()).newSessionTarget === 'recent',
    (await controller.baseline()).newSessionTarget)

  // `global.set` replaces the whole singleton, so this is the regression that
  // matters: writing the target must leave the order intact.
  check('writing the target did NOT drop the project order',
    (await controller.baseline()).projectIds.join(',') === `${b},${a}`,
    (await controller.baseline()).projectIds.join(','))

  // And the reverse direction: reordering must not reset the choice.
  await controller.reorder({ projectId: a, beforeId: b })
  check('reordering did NOT reset the destination choice',
    (await controller.baseline()).newSessionTarget === 'recent',
    (await controller.baseline()).newSessionTarget)
  check('and the reorder still took effect',
    (await controller.baseline()).projectIds.join(',') === `${a},${b}`,
    (await controller.baseline()).projectIds.join(','))

  // Deleting must not reset it either.
  await controller.remove({ projectId: a })
  check('deleting a project did NOT reset the destination choice',
    (await controller.baseline()).newSessionTarget === 'recent',
    (await controller.baseline()).newSessionTarget)

  check('the durable unit holds the choice',
    backend.units.get(PROJECT_DOMAIN_NAME).global.newSessionTarget === 'recent',
    JSON.stringify(backend.units.get(PROJECT_DOMAIN_NAME).global))
}

// 15. A unit written before `newSessionTarget` existed still opens, and reads
//     back the schema's default rather than `undefined`.
{
  const { controller, backend } = bench()
  await controller.create({ title: 'legacy' })
  // Simulate a medium written by an older build: the global has no such field.
  const unit = backend.units.get(PROJECT_DOMAIN_NAME)
  const legacy = { projectIds: [...unit.global.projectIds] }
  check('the fixture really lacks the field', !('newSessionTarget' in legacy), JSON.stringify(legacy))
  unit.global = legacy

  // A separate Context, as a restart has: the stored value is re-parsed on open.
  const reopened = new ProjectController(benchContext(backend))
  const baseline = await reopened.baseline()
  check('a unit without the field still opens', baseline.projects.length === 1,
    JSON.stringify(baseline.projects.map(p => p.title)))
  check('and reads back the default destination', baseline.newSessionTarget === 'ungrouped',
    String(baseline.newSessionTarget))
  check('with its project order intact', baseline.projectIds.length === 1,
    baseline.projectIds.join(','))
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
