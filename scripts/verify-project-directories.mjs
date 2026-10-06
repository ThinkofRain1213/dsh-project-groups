/**
 * Behaviour test for this plugin's associated-directory and injection surface.
 *
 * Drives the real `ProjectController` against a real domain facility over the
 * in-memory JSON backend, exactly as `verify-project-host.mjs` does and for the
 * same reason: `@Remote` only marks the prototype, so calling the methods
 * directly is the code path the Gateway reaches after decoding.
 *
 * What this pins down, and why each one is worth a check:
 *
 *   - `directories` defaults to `[]` on a record written before the field
 *     existed. A missing default makes the whole domain open reject, which
 *     takes every project with it, so this is the highest-stakes assertion here.
 *   - `create` accepts a list, so the create dialog can commit directories in
 *     one write instead of leaving a briefly-empty project behind.
 *   - `setDirectories` replaces the whole list and preserves every other field —
 *     a table `put` replaces the value, so a sloppy spread would silently drop
 *     the title.
 *   - The two injection switches round-trip independently, and writing one does
 *     not disturb `projectIds` (the whole-global overwrite hazard).
 */
import { register } from 'node:module'

register('./lib/ts-loader.mjs', import.meta.url)

const { Context } = await import('@deepseek-ai/cordis')
const { DomainFacility } = await import('@deepseek-ai/dsh-storage-domain')
const { ProjectController } = await import('../src/index.ts')
const { PROJECT_DOMAIN_NAME, projectDomainSpec, projectRecord, globalRecord } = await import('../src/spec.ts')

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

function benchContext(backend) {
  const ctx = new Context()
  ctx.provide('storage', { backend: { get: () => backend } })
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'memory' }))
  return ctx
}

function bench() {
  const backend = memoryBackend()
  return { ctx: benchContext(backend), controller: new ProjectController(benchContext(backend)), backend }
}

// 1. Schema-level: a record written before `directories` existed reads back as [].
//    This is the domain-open-reject guard, asserted against the shipped schema.
{
  const legacy = {
    title: 'legacy',
    docPath: '',
    createdAt: '2026-09-30T03:45:15.911Z',
    updatedAt: '2026-09-30T03:45:15.911Z',
  }
  const parsed = projectRecord.parse(legacy)
  check('a pre-directories record parses', parsed.title === 'legacy')
  check('and reads back directories as []',
    Array.isArray(parsed.directories) && parsed.directories.length === 0,
    JSON.stringify(parsed.directories))

  // The counter-example: without the default, the same stored record would reject,
  // which is what makes the whole domain unreadable rather than one row.
  const { z } = await import('zod')
  const strict = z.object({
    title: z.string(), directories: z.array(z.string()), docPath: z.string(),
    createdAt: z.string(), updatedAt: z.string(),
  })
  check('without .default() it would reject (so the default is load-bearing)',
    strict.safeParse(legacy).success === false)
}

// 2. A global written before the switches existed reads both as their defaults.
{
  const legacyGlobal = {
    projectIds: ['p1'],
    newSessionTarget: 'recent',
    baseWorkspace: { mode: 'default' },
    createOpensSession: false,
  }
  const parsed = globalRecord.parse(legacyGlobal)
  check('a pre-switch global parses', parsed.projectIds.join(',') === 'p1')
  check('injectProjectInfo reads back true (base feature, on)',
    parsed.injectProjectInfo === true, String(parsed.injectProjectInfo))
  check('injectProjectDoc reads back false (extra feature, off)',
    parsed.injectProjectDoc === false, String(parsed.injectProjectDoc))
  check('and the pre-existing values are preserved',
    parsed.createOpensSession === false && parsed.newSessionTarget === 'recent')
}

// 3. A fresh Host reports both switches, at their defaults.
{
  const { controller } = bench()
  const baseline = await controller.baseline()
  check('a fresh baseline reports injectProjectInfo true', baseline.injectProjectInfo === true)
  check('a fresh baseline reports injectProjectDoc false', baseline.injectProjectDoc === false)
}

// 4. create accepts directories, and they land on the projection and the record.
{
  const { controller, backend } = bench()
  const created = await controller.create({
    title: 'with dirs',
    directories: ['C:\\work\\a', 'D:\\work\\b'],
  })
  check('create returns the directories it stored',
    created.project.directories.join('|') === 'C:\\work\\a|D:\\work\\b',
    created.project.directories.join('|'))
  const stored = backend.units.get(PROJECT_DOMAIN_NAME).tables.projects[created.project.projectId]
  check('and they are durable on the record',
    stored.directories.join('|') === 'C:\\work\\a|D:\\work\\b', JSON.stringify(stored.directories))
  const baseline = await controller.baseline()
  check('and the baseline carries them too',
    baseline.projects[0].directories.length === 2)
}

// 5. create without directories still yields a real empty list, not undefined.
{
  const { controller } = bench()
  const created = await controller.create({ title: 'no dirs' })
  check('omitting directories stores []',
    Array.isArray(created.project.directories) && created.project.directories.length === 0,
    JSON.stringify(created.project.directories))
}

// 6. The created array is copied, not aliased: mutating the caller's array later
//    must not reach stored state.
{
  const { controller, backend } = bench()
  const mine = ['C:\\one']
  const created = await controller.create({ title: 'aliasing', directories: mine })
  mine.push('C:\\injected')
  const stored = backend.units.get(PROJECT_DOMAIN_NAME).tables.projects[created.project.projectId]
  check('a mutated caller array does not reach the record',
    stored.directories.join('|') === 'C:\\one', stored.directories.join('|'))
}

// 7. setDirectories replaces the whole list, preserving every other field.
{
  const { controller, backend } = bench()
  const created = await controller.create({ title: 'keep me', directories: ['C:\\old'] })
  const id = created.project.projectId
  const value = await controller.setDirectories({ projectId: id, directories: ['D:\\new', 'E:\\also'] })
  check('setDirectories answers with the stored list',
    value.directories.join('|') === 'D:\\new|E:\\also', value.directories.join('|'))
  const stored = backend.units.get(PROJECT_DOMAIN_NAME).tables.projects[id]
  check('the title survives the replace', stored.title === 'keep me', stored.title)
  check('docPath survives the replace', stored.docPath === '', JSON.stringify(stored.docPath))
  // `>=`, not `>`: ISO-8601 stamps have millisecond resolution, so two writes in
  // the same millisecond legitimately carry the same instant. `verify-project-host.mjs`
  // asserts `rename` the same way for the same reason.
  check('updatedAt does not go backwards', stored.updatedAt >= created.project.updatedAt,
    `${created.project.updatedAt} -> ${stored.updatedAt}`)
  check('and the old list is gone', !stored.directories.includes('C:\\old'))
}

// 8. Clearing to an empty list is a real value, not a delete.
{
  const { controller, backend } = bench()
  const created = await controller.create({ title: 'clear', directories: ['C:\\x'] })
  await controller.setDirectories({ projectId: created.project.projectId, directories: [] })
  const stored = backend.units.get(PROJECT_DOMAIN_NAME).tables.projects[created.project.projectId]
  check('an empty list is stored as []',
    Array.isArray(stored.directories) && stored.directories.length === 0,
    JSON.stringify(stored.directories))
}

// 9. setDirectories refuses an unknown project rather than creating one.
{
  const { controller } = bench()
  let refused = false
  try {
    await controller.setDirectories({ projectId: 'nope', directories: ['C:\\x'] })
  } catch { refused = true }
  check('setDirectories refuses an unknown project', refused)
  check('and created nothing', (await controller.baseline()).projects.length === 0)
}

// 10. The two switches round-trip independently and preserve the global.
{
  const { controller, backend } = bench()
  const created = await controller.create({ title: 'keep the order' })
  check('setInjectProjectInfo answers with the stored value',
    (await controller.setInjectProjectInfo({ value: false })).value === false)
  check('setInjectProjectDoc answers with the stored value',
    (await controller.setInjectProjectDoc({ value: true })).value === true)
  const baseline = await controller.baseline()
  check('the first switch stuck', baseline.injectProjectInfo === false)
  check('the second switch stuck', baseline.injectProjectDoc === true)
  check('the project order survived both writes',
    baseline.projectIds.join(',') === created.project.projectId,
    baseline.projectIds.join(','))
  const storedGlobal = backend.units.get(PROJECT_DOMAIN_NAME).global
  check('nothing else in the global was dropped',
    Array.isArray(storedGlobal.projectIds) && storedGlobal.projectIds.length === 1
    && storedGlobal.createOpensSession === true,
    JSON.stringify(storedGlobal))
}

// 11. Toggling back is a real second write, not a no-op.
{
  const { controller } = bench()
  await controller.setInjectProjectInfo({ value: false })
  await controller.setInjectProjectInfo({ value: true })
  check('toggling back reports true again',
    (await controller.baseline()).injectProjectInfo === true)
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
