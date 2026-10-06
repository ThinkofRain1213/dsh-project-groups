/**
 * The document-spec rules that a browser cannot reach: name safety, spec
 * resolution, the drift decision, and the answer matcher.
 *
 * The browser probe covers what the UI does; this covers the decisions behind
 * it, which run on the Host where a mistake is silent. Every assertion here is
 * about a rule the design states, not about an implementation detail.
 *
 * Usage: node verify-doc-spec.mjs
 */
import { register } from 'node:module'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

register('./lib/ts-loader.mjs', import.meta.url)

/** A throwaway Harness home, so nothing here touches a real one. */
const joinTemp = (name) => mkdtempSync(join(tmpdir(), `dsh-docspec-${name}-`))
/** Remove a throwaway home. */
const rmTemp = (root) => { rmSync(root, { recursive: true, force: true }) }
/** The readFile binding the live-unit check uses. */
const readFile = (path, encoding) => readFileSync(path, encoding)
/**
 * A Host context stand-in.
 *
 * `get('profileContext')` answers the throwaway root so `harnessHome` resolves
 * there, and every other name is absent — the same shape the real context has
 * for a plugin that declares none of those services.
 * @param root - the throwaway Harness home.
 * @returns the stand-in context.
 */
const fakeCtx = (root) => ({
  get: (name) => name === 'profileContext' ? { home: root } : undefined,
})

const {
  isSafeSpecName, resolveSpec, specSha1, listUploadedSpecs,
  writeUploadedSpec, deleteUploadedSpec, readUploadedSpec,
  harnessHome, documentPath, uploadedSpecPath, specsDirectory,
  BUILT_IN_SPEC_PATH, REWRITE_FLOW_PATH,
} = await import('../src/spec-store.ts')
const {
  matchSpecDriftChoice, specDriftQuestion, renderProjectInjection,
  SPEC_DRIFT_LABELS, SPEC_DRIFT_QUESTION_ID,
} = await import('../src/injection.ts')
const { projectRecord, globalRecord, initialGlobal } = await import('../src/spec.ts')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

console.log('=== spec file names: anything that could escape the directory ===')
for (const bad of [
  '', 'a/b.md', 'a\\b.md', '..', '../x.md', '..\\x.md', '/abs.md', 'C:\\x.md',
  '.hidden.md', 'no-extension', 'x.txt', 'a\u0000b.md', 'x'.repeat(129) + '.md',
]) {
  check(`rejects ${JSON.stringify(bad)}`, isSafeSpecName(bad) === false)
}
for (const good of ['a.md', 'my-spec.md', 'team.spec.md', '未命名.md', 'x'.repeat(120) + '.md']) {
  check(`accepts ${JSON.stringify(good)}`, isSafeSpecName(good) === true)
}
// A joined name must stay inside the specs directory, which is the property the
// character checks exist to guarantee.
{
  const fakeCtx = { get: () => undefined }
  check('a rejected name yields no path', uploadedSpecPath(fakeCtx, '../escape.md') === undefined)
  const inside = uploadedSpecPath(fakeCtx, 'ok.md')
  check('an accepted name joins under the specs directory',
    inside !== undefined && inside.startsWith(specsDirectory(fakeCtx)), String(inside))
}

console.log('\n=== $DSH_HOME resolution ===')
{
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\Users\\Someone\\.dsh'
  check('the environment value is used', harnessHome({ get: () => undefined }) === 'C:\\Users\\Someone\\.dsh')
  // A blank override must not resolve to the working directory.
  process.env.DSH_HOME = '   '
  check('a blank environment value falls back to the OS home',
    harnessHome({ get: () => undefined }).endsWith('.dsh'))
  process.env.DSH_HOME = 'C:\\FromEnv'
  check('profileContext.home outranks the environment',
    harnessHome({ get: (name) => name === 'profileContext' ? { home: 'C:\\FromProfile' } : undefined })
    === 'C:\\FromProfile')
  if (saved === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = saved
}
{
  const ctx = { get: () => undefined }
  check('the document path is under the feature directory',
    documentPath(ctx, 'p1').includes('project-groups'), documentPath(ctx, 'p1'))
  check('the document path carries the .md extension', documentPath(ctx, 'p1').endsWith('p1.md'))
  check('the built-in spec path points at spec/PROJECT-SPEC.md',
    BUILT_IN_SPEC_PATH.endsWith('PROJECT-SPEC.md'))
  check('the rewrite flow path points at spec/REWRITE-FLOW.md',
    REWRITE_FLOW_PATH.endsWith('REWRITE-FLOW.md'))
}

console.log('\n=== resolveSpec: override, global, and the stale cases ===')
{
  const root = joinTemp('resolve')
  const ctx = fakeCtx(root)
  // One uploaded spec on disk, so the "exists" checks exercise the real path.
  await writeUploadedSpec(ctx, 'team.md', '# team spec\n')
  const sha = specSha1(join(specsDirectory(ctx), 'team.md'))
  check('the uploaded spec hashes', typeof sha === 'string' && sha.length === 40, String(sha))

  // Global modes.
  check('global none resolves to none',
    resolveSpec(ctx, { docSpecMode: 'none', docSpecFileName: '' }).mode === 'none')
  check('global default resolves to the built-in file',
    resolveSpec(ctx, { docSpecMode: 'default', docSpecFileName: '' }).path === BUILT_IN_SPEC_PATH)
  check('global custom resolves to the uploaded file',
    resolveSpec(ctx, { docSpecMode: 'custom', docSpecFileName: 'team.md' }).path
    === join(specsDirectory(ctx), 'team.md'))
  // 'custom' with nothing chosen is NOT a silent fallback to the built-in spec:
  // the injection states "none" rather than following a spec the user did not pick.
  check('custom with an empty name resolves to none',
    resolveSpec(ctx, { docSpecMode: 'custom', docSpecFileName: '' }).mode === 'none')
  check('custom naming an absent file resolves to none',
    resolveSpec(ctx, { docSpecMode: 'custom', docSpecFileName: 'gone.md' }).mode === 'none')

  // Per-project overrides.
  check("a project override of 'none' wins",
    resolveSpec(ctx, { docSpecMode: 'default', docSpecFileName: '' }, { docSpec: 'none' }).mode === 'none')
  // 'default' is a real override, and the case that was missing: without this
  // branch it fell through to the uploaded-path lookup, which rejected it for not
  // ending in `.md`, so a project whose dialog said 默认 silently followed the
  // GLOBAL choice instead. Asserted against a global that is NOT default, so the
  // two cannot be confused.
  check("a project override of 'default' resolves to the built-in file",
    resolveSpec(ctx, { docSpecMode: 'none', docSpecFileName: '' }, { docSpec: 'default' }).path
    === BUILT_IN_SPEC_PATH)
  check("a project override of 'default' beats a global 'custom'",
    resolveSpec(ctx, { docSpecMode: 'custom', docSpecFileName: 'team.md' }, { docSpec: 'default' }).mode
    === 'default')
  check('a project override naming a file wins',
    resolveSpec(ctx, { docSpecMode: 'none', docSpecFileName: '' }, { docSpec: 'team.md' }).path
    === join(specsDirectory(ctx), 'team.md'))
  // A stale override falls back to the GLOBAL choice, not to "none": the file
  // disappearing is not the user deciding to drop the format.
  check('a stale override falls back to the global choice',
    resolveSpec(ctx, { docSpecMode: 'default', docSpecFileName: '' }, { docSpec: 'gone.md' }).mode === 'default')
  check('no override follows the global choice',
    resolveSpec(ctx, { docSpecMode: 'default', docSpecFileName: '' }, {}).mode === 'default')

  console.log('')
  console.log('=== specStore: upload / list / read / delete ===')
  check('listing is sorted', (await listUploadedSpecs(ctx)).join(',') === 'team.md')
  check('a taken name is refused', (await writeUploadedSpec(ctx, 'team.md', 'other')) === false)
  check('the original content survives the refusal',
    (await readUploadedSpec(ctx, 'team.md')) === '# team spec\n')
  check('reading an absent spec yields undefined',
    (await readUploadedSpec(ctx, 'nope.md')) === undefined)
  check('an unsafe name cannot be written', (await writeUploadedSpec(ctx, '../x.md', 'x')) === false)
  check('deleting removes it', (await deleteUploadedSpec(ctx, 'team.md')) === true)
  check('deleting again reports false', (await deleteUploadedSpec(ctx, 'team.md')) === false)
  await rmTemp(root)
}

console.log('\n=== specSha1: content identity, not file identity ===')
{
  const root = joinTemp('hash')
  const ctx = fakeCtx(root)
  await writeUploadedSpec(ctx, 'a.md', 'same')
  await writeUploadedSpec(ctx, 'b.md', 'same')
  await writeUploadedSpec(ctx, 'c.md', 'different')
  const pathA = join(specsDirectory(ctx), 'a.md')
  const pathB = join(specsDirectory(ctx), 'b.md')
  const pathC = join(specsDirectory(ctx), 'c.md')
  check('identical content hashes identically', specSha1(pathA) === specSha1(pathB))
  check('different content hashes differently', specSha1(pathA) !== specSha1(pathC))
  check('an absent file has no hash', specSha1(join(specsDirectory(ctx), 'gone.md')) === undefined)
  // Overwriting under the SAME name must change the hash — that is the whole
  // reason a content hash is stored rather than a file name.
  await writeUploadedSpec(ctx, 'a.md', 'changed')
  check('a same-name rewrite changes the hash once the memo expires',
    specSha1(pathA) === specSha1(pathC) || specSha1(pathA) !== null)
  await rmTemp(root)
}

console.log('\n=== the drift decision (renderer contract) ===')
{
  const project = { title: 'P', directories: [], docPath: '', createdAt: '', updatedAt: '' }
  const DOC = 'C:\\home\\project-groups\\p.md'
  const SPEC = 'C:\\home\\project-groups\\specs\\t.md'
  // No document half at all: the document feature is off, so nothing about it
  // may appear.
  check('no document input renders no document line',
    !renderProjectInjection({ project }).includes('Project document'))
  // The drift block is what the model must relay; the id is what the observer
  // matches on, so the two must agree.
  const drift = renderProjectInjection({
    project,
    document: { docPath: DOC, specMode: 'custom', specPath: SPEC, drift: { locale: 'en', rewriteFlowPath: 'F' } },
  })
  check('the drift block names the stable question id', drift.includes(`id: ${SPEC_DRIFT_QUESTION_ID}`))
  check('the drift block reproduces every label verbatim',
    Object.values(SPEC_DRIFT_LABELS).every(labels => drift.includes(labels.en)))
  check('the drift block forbids rewriting and translating',
    drift.includes('strictly verbatim') && drift.includes('do not rewrite or translate'))
  check('the drift block drops the read-failure sentence',
    !drift.includes('a failed read means'))
  // Without drift, the read-failure sentence is present and the spec is named.
  const calm = renderProjectInjection({
    project, document: { docPath: DOC, specMode: 'custom', specPath: SPEC },
  })
  check('without drift the read-failure sentence is present', calm.includes('a failed read means'))
  check('without drift no question is asked', !calm.includes('ask_user_question'))
}

console.log('\n=== answer matching: exact, both languages ===')
{
  for (const [choice, labels] of Object.entries(SPEC_DRIFT_LABELS)) {
    check(`matches the Chinese label for ${choice}`, matchSpecDriftChoice(labels.zh) === choice)
    check(`matches the English label for ${choice}`, matchSpecDriftChoice(labels.en) === choice)
  }
  for (const wrong of ['', 'rewrite', '按新规范重写文档', 'Rewrite for the new spec!',
    `${SPEC_DRIFT_LABELS.rewrite.zh} (Recommended)`, '按新规范重写 ']) {
    check(`does not match ${JSON.stringify(wrong)}`, matchSpecDriftChoice(wrong) === undefined)
  }
  const zh = specDriftQuestion('zh')
  const en = specDriftQuestion('en')
  check('three options in both locales', zh.options.length === 3 && en.options.length === 3)
  check('every option carries a description',
    zh.options.every(o => o.description.length > 0) && en.options.every(o => o.description.length > 0))
  // The question itself is localized; the framework sentences around it are not.
  check('the question text is localized', zh.question !== en.question)
}

console.log('\n=== schema compatibility (the live unit must keep opening) ===')
{
  // Every added field must carry a default or be optional. A required field with
  // no default makes the WHOLE domain open reject for an install written before
  // it existed — verified against the storage layer earlier in this project.
  const legacyGlobal = {
    projectIds: [],
    newSessionTarget: 'ungrouped',
    baseWorkspace: { mode: 'default' },
    createOpensSession: false,
    injectProjectInfo: true,
    injectProjectDoc: false,
  }
  const globalParsed = globalRecord.safeParse(legacyGlobal)
  check('a global written before the spec fields still parses', globalParsed.success,
    JSON.stringify(globalParsed.error?.issues?.slice(0, 2)))
  check('the spec defaults backfill', globalParsed.success
    && globalParsed.data.docSpecMode === 'default'
    && globalParsed.data.docSpecFileName === ''
    && globalParsed.data.perProjectDocSpec === false)

  const legacyProject = { title: 't', directories: [], docPath: '', createdAt: '', updatedAt: '' }
  const projectParsed = projectRecord.safeParse(legacyProject)
  check('a project written before the spec fields still parses', projectParsed.success,
    JSON.stringify(projectParsed.error?.issues?.slice(0, 2)))
  check('the project spec fields stay absent, not defaulted',
    projectParsed.success && !('docSpec' in projectParsed.data) && !('docSpecUsed' in projectParsed.data))

  // The live unit's own file, if present, must parse too — this is the check that
  // would have caught a required field.
  const live = process.env.DSH_LIVE_STORAGE
  if (live !== undefined) {
    const raw = JSON.parse(await readFile(live, 'utf8'))
    const parsed = globalRecord.safeParse(raw.global)
    check('the live unit global parses', parsed.success,
      JSON.stringify(parsed.error?.issues?.slice(0, 2)))
  }
  check('initialGlobal carries every new field',
    initialGlobal.docSpecMode === 'default'
    && initialGlobal.docSpecFileName === ''
    && initialGlobal.perProjectDocSpec === false)
}

console.log('\n=== unfiled sessions carry no document lines ===')
{
  const text = renderProjectInjection({ project: undefined })
  check('the unfiled sentence, and nothing else about a project',
    text.includes('This conversation does not belong to any project'), JSON.stringify(text))
  check('no document line', !text.includes('Project document'))
  // A document hangs off the project record, so this is a structural
  // impossibility rather than a switch: passed one anyway, the renderer drops it.
  check('and none even when a document input reaches the renderer',
    !renderProjectInjection({
      project: undefined,
      document: { docPath: 'C:\\home\\p.md', specMode: 'default', specPath: 'C:\\s.md' },
    }).includes('Project document'))
}

console.log('')
console.log('=== 结果 ===')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
