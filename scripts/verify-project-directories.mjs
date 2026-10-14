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
            // Records are **cloned** when served. `{ ...rows }` copies only the row *map*, so
            // every record the controller received was the very object held in `state.tables`,
            // and a mutation to it reached the store. A real JSON backend serializes and parses,
            // so what it returns is detached from durable state; without the clone this harness
            // would both fabricate and mask the aliasing behaviour it exists to pin.
            //
            // Read-side only, deliberately. Cloning on write as well would detach the stored
            // record from the caller's array inside `putRecord`, and block 6 — "a mutated caller
            // array does not reach the record" — would then pass whether or not the controller
            // copies. The write path stays by-reference so that assertion keeps its teeth.
            return {
              global: state.global === null ? null : structuredClone(state.global),
              tables: Object.fromEntries(
                Object.entries(state.tables).map(([table, rows]) => [
                  table,
                  Object.fromEntries(
                    Object.entries(rows).map(([key, rec]) => [key, structuredClone(rec)]),
                  ),
                ]),
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

/**
 * Build a Host context over a fresh backend, plus the controller under test.
 *
 * One context, not two. `benchContext(backend)` used to be called twice — once for a returned
 * `ctx` that no call site destructures, and again for the controller — so every bench built a
 * second `Context`/`DomainFacility` over the same backend for nothing. It also meant the
 * controller was bound to a **different** context than the exposed `ctx`, and since each
 * facility keeps its own cached state, a future check reading through `ctx` would have observed
 * stale data with no error.
 */
function bench() {
  const backend = memoryBackend()
  const ctx = benchContext(backend)
  return { ctx, controller: new ProjectController(ctx), backend }
}

/** One stored record, or `undefined` when any hop is missing. */
function storedRecord(backend, projectId) {
  return backend.units.get(PROJECT_DOMAIN_NAME)?.tables?.projects?.[projectId]
}

/** The stored global singleton, or `undefined`. */
function storedGlobalOf(backend) {
  return backend.units.get(PROJECT_DOMAIN_NAME)?.global
}

/**
 * A durable record written before one of the later fields existed.
 *
 * Both legacy fixtures used to spell the same literal out, differing only in `directories` and
 * `title`, so a field added to `projectRecord` had to be added in two places — and the
 * compatibility contract these blocks assert ("an old record reads back with defaults rather
 * than rejecting the domain open") is exactly what that drift would break.
 * @param overrides - the fields this fixture varies by.
 * @returns the stored shape.
 */
function legacyProjectRecord(overrides) {
  // No `directories` default here on purpose: the first fixture's whole point is that the field
  // is **absent** from a record written before it existed. Giving this factory a default of `[]`
  // made the counter-example below parse successfully, so the assertion that `.default()` is
  // load-bearing failed — the fixture had quietly supplied the very field whose absence was
  // under test. Each caller names the fields its own era had.
  return {
    title: 'legacy',
    docPath: '',
    createdAt: '2026-09-30T03:45:15.911Z',
    updatedAt: '2026-09-30T03:45:15.911Z',
    ...overrides,
  }
}

/**
 * The "one write must not clobber the rest of the global singleton" contract.
 *
 * Stated once rather than twice. Block 10 and block 14 asserted the same shape with only the
 * trailing field differing, so two copies could disagree about what "nothing else" covers.
 * @param stored - the stored global.
 * @param extraField - the one field this write was expected to change.
 * @returns whether the singleton survived intact.
 */
function globalPreservedExcept(stored, extraField) {
  return Array.isArray(stored?.projectIds) && stored.projectIds.length === 1 && extraField === true
}

// 1. Schema-level: a record written before `directories` existed reads back as [].
//    This is the domain-open-reject guard, asserted against the shipped schema.
{
  const legacy = legacyProjectRecord({ title: 'legacy' })
  const parsed = projectRecord.parse(legacy)
  check('a pre-directories record parses', parsed.title === 'legacy')
  check('and reads back directories as []',
    Array.isArray(parsed.directories) && parsed.directories.length === 0,
    JSON.stringify(parsed.directories))

  // The counter-example: without the default, the same stored record would reject,
  // which is what makes the whole domain unreadable rather than one row.
  const { z } = await import('zod')
  const strict = projectRecord.extend({ directories: z.array(z.string()) })
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
  const stored = storedRecord(backend, created.project.projectId)
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
  const stored = storedRecord(backend, created.project.projectId)
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
  const stored = storedRecord(backend, id)
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
  const stored = storedRecord(backend, created.project.projectId)
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
  const storedGlobal = storedGlobalOf(backend)
  check('nothing else in the global was dropped',
    globalPreservedExcept(storedGlobal, storedGlobal?.createOpensSession), JSON.stringify(storedGlobal))
}

// 11. Toggling back is a real second write, not a no-op.
{
  const { controller } = bench()
  await controller.setInjectProjectInfo({ value: false })
  await controller.setInjectProjectInfo({ value: true })
  check('toggling back reports true again',
    (await controller.baseline()).injectProjectInfo === true)
}

// 12. `links`: the same compatibility contract as `directories`, asserted separately
//     because a field with its own default is its own rejection risk. A record written
//     before the field existed must read back as `[]` rather than failing the domain open,
//     which would take every project with it.
{
  const legacy = legacyProjectRecord({ title: 'pre-links', directories: [] })
  const parsed = projectRecord.parse(legacy)
  check('a pre-links record parses', parsed.title === 'pre-links')
  check('and reads back links as []',
    Array.isArray(parsed.links) && parsed.links.length === 0, JSON.stringify(parsed.links))
}

// 13. `links` round-trips through create, update and the baseline, in display order.
//     Order is part of the value here as much as it is for directories: the injection
//     prints the list in the order stored.
{
  const { controller } = bench()
  const created = await controller.create({
    title: 'linked',
    links: ['https://github.com/a/b', 'https://example.com/c'],
  })
  check('create stores the links in order',
    created.project.links.join('|') === 'https://github.com/a/b|https://example.com/c',
    JSON.stringify(created.project.links))

  // A list the Host never validated: the switch only governs the editor's marking, so a
  // non-URL must be storable. Asserting this here is what stops a later change from
  // quietly turning the marking into a refusal.
  const withFreeText = await controller.create({ title: 'free', links: ['not a url'] })
  check('a non-URL link is stored verbatim',
    withFreeText.project.links.join('|') === 'not a url',
    JSON.stringify(withFreeText.project.links))

  const updated = await controller.update({
    projectId: created.project.projectId,
    title: 'linked',
    directories: [],
    links: ['https://example.com/only'],
  })
  check('update replaces the list whole',
    updated.project.links.join('|') === 'https://example.com/only',
    JSON.stringify(updated.project.links))
  check('and an empty list is a real value',
    (await controller.update({
      projectId: created.project.projectId,
      title: 'linked',
      directories: [],
      links: [],
    })).project.links.length === 0)

  // Blank rows are dropped on **both** write paths, from one shared rule.
  //
  // This is the defect that prompted the check: the design said "drop blanks when storing"
  // and the implementation dropped nothing, so an empty row became a real link — a bare
  // `- ` in the injected block and a ghost row in the next dialog that then read as
  // "unchanged", leaving 保存 disabled. Both halves are asserted here because a rule written
  // twice is a rule that eventually disagrees with itself (`docSpec` in Z-3 was exactly that).
  const blanks = ['', '   ', '\t']
  const viaCreate = await controller.create({ title: 'blanks-create', links: [...blanks, 'https://x'] })
  check('create drops blank rows and keeps the rest',
    viaCreate.project.links.join('|') === 'https://x',
    JSON.stringify(viaCreate.project.links))

  const viaUpdate = await controller.create({ title: 'blanks-update', links: ['https://keep'] })
  check('update drops blank rows too',
    (await controller.update({
      projectId: viaUpdate.project.projectId,
      title: 'blanks-update',
      directories: [],
      links: [...blanks, 'https://kept'],
    })).project.links.join('|') === 'https://kept')
  check('an all-blank list stores as empty',
    (await controller.update({
      projectId: viaUpdate.project.projectId,
      title: 'blanks-update',
      directories: [],
      links: [...blanks],
    })).project.links.length === 0)

  // The other half of "marking, not a refusal": a non-blank value that fails the URL check
  // must survive the filter. Dropping it would turn marking into the gate the design
  // rejected, and this is the assertion that stops a later "tidy-up" from doing so.
  const keptUnusable = await controller.create({ title: 'unusable', links: ['', 'not a url'] })
  check('a blank-only drop does not touch an unusable non-blank link',
    keptUnusable.project.links.join('|') === 'not a url',
    JSON.stringify(keptUnusable.project.links))

  // Content is not trimmed: only blanks are removed, so a padded URL keeps its spelling.
  const padded = await controller.create({ title: 'padded', links: ['  https://x  '] })
  check('a padded link is kept verbatim, not trimmed',
    padded.project.links.join('|') === '  https://x  ',
    JSON.stringify(padded.project.links))

  const baseline = await controller.baseline()
  check('the baseline carries links for every project',
    baseline.projects.every(project => Array.isArray(project.links)),
    JSON.stringify(baseline.projects.map(project => project.links)))
}

// 14. `validateLinks` round-trips and preserves the rest of the global.
{
  const { controller, backend } = bench()
  const created = await controller.create({ title: 'order keeper' })
  check('a fresh install marks by default',
    (await controller.baseline()).validateLinks === true)
  check('setValidateLinks answers with the stored value',
    (await controller.setValidateLinks({ value: false })).value === false)
  const baseline = await controller.baseline()
  check('the switch stuck', baseline.validateLinks === false)
  check('the project order survived the write',
    baseline.projectIds.join(',') === created.project.projectId)
  const storedGlobal = storedGlobalOf(backend)
  check('nothing else in the global was dropped',
    globalPreservedExcept(storedGlobal, storedGlobal?.injectProjectInfo), JSON.stringify(storedGlobal))
}

// 15. `isValidLink`: the rule `validateLinks` marks with.
//
// This had no coverage at all, which is how the case-sensitivity of the scheme check went
// unnoticed: RFC 3986 makes URL schemes case-insensitive, so `HTTP://example.com` is a valid
// link, and rejecting it marked a working link as invalid in the dialog. Asserted here rather
// than left to the UI probe, because the rule is a pure function and the failure is invisible
// unless someone types a capitalised scheme.
{
  const { isValidLink } = await import('../src/protocol.ts')
  for (const good of [
    'http://example.com', 'https://example.com',
    'HTTP://example.com', 'HTTPS://example.com', 'Http://example.com',
    '  https://example.com/path?q=1  ',
  ]) {
    check(`isValidLink accepts ${JSON.stringify(good)}`, isValidLink(good) === true)
  }
  for (const bad of [
    'ftp://example.com', 'example.com', '//example.com', 'javascript:alert(1)',
    'httpx://example.com', '',
  ]) {
    check(`isValidLink rejects ${JSON.stringify(bad)}`, isValidLink(bad) === false)
  }
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
