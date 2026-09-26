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

// 2. Create appends in call order and lands durably.
{
  const { controller, backend } = bench()
  const first = await controller.create({ title: '项目一' })
  const second = await controller.create({ title: 'second' })
  check('create returns a titled project', first.project.title === '项目一')
  check('create generates a distinct id', first.project.projectId !== second.project.projectId)
  check('create records no document yet', first.project.docPath === '')

  const baseline = await controller.baseline()
  check('baseline lists both in creation order',
    baseline.projects.map(p => p.title).join(',') === '项目一,second',
    baseline.projects.map(p => p.title).join(','))
  check('the durable unit was opened', backend.units.has(PROJECT_DOMAIN_NAME),
    [...backend.units.keys()].join(','))
  check('the record landed in the table',
    Object.keys(backend.units.get(PROJECT_DOMAIN_NAME).tables.projects ?? {}).length === 2)
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

  const moved = await controller.reorder({ projectId: c, beforeId: a })
  check('reorder places the project before its anchor',
    moved.projectIds.join(',') === `${c},${a},${b}`, moved.projectIds.join(','))
  check('the baseline follows the new order',
    (await controller.baseline()).projects.map(p => p.title).join(',') === 'c,a,b')

  const appended = await controller.reorder({ projectId: a })
  check('an absent anchor appends',
    appended.projectIds.join(',') === `${c},${b},${a}`, appended.projectIds.join(','))

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

// 9. A record without an order entry stays visible.
{
  const { controller, backend } = bench()
  await controller.create({ title: 'orphan' })
  // Simulate a medium whose order array lost an entry (an interrupted write, or
  // a hand-edit): the record must still be listed rather than silently dropped.
  const unit = backend.units.get(PROJECT_DOMAIN_NAME)
  unit.global = { projectIds: [] }
  const baseline = await controller.baseline()
  check('a record missing from the order is still listed',
    baseline.projects.map(p => p.title).join(',') === 'orphan',
    baseline.projects.map(p => p.title).join(','))
  check('and it is appended to the reported order',
    baseline.projectIds.length === 1, baseline.projectIds.join(','))
}

// 10. The domain descriptor this plugin hands the facility is the one it owns.
{
  const descriptor = descriptorOf(projectDomainSpec)
  check('the domain descriptor names the snake_case unit', descriptor.name === PROJECT_DOMAIN_NAME)
  check('the descriptor declares every table',
    descriptor.tables.slice().sort().join(',') === 'assignments,expansions,projects',
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

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
