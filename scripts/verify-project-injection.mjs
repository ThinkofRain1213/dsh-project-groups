/**
 * Behaviour test for this plugin's runtime-context injection.
 *
 * Two layers, both exercised here because they fail differently:
 *
 *   - the **renderer** (`src/injection.ts`) is pure, so its assertions are exact
 *     string comparisons over every shape the data can take;
 *   - the **lineage walk** is modelled against a fake Session store shaped like
 *     the real `SessionStore`, so the subagent cases — the ones a single-session
 *     probe cannot reach — are covered deterministically.
 *
 * The walk is transcribed rather than imported: the real one is a private method
 * of `ProjectController`, and reaching it would mean standing up the whole
 * storage-domain facility to test a five-line loop. What is verified here is the
 * *algorithm*; `verify-project-host.mjs` covers the controller's public surface,
 * and the wiring itself is asserted by the host-import and descriptor probes run
 * from `pnpm check`.
 */
import { register } from 'node:module'

register('./lib/ts-loader.mjs', import.meta.url)

const { renderProjectInjection, shouldAskSpecDrift, PROJECT_CONTEXT_OPEN, PROJECT_CONTEXT_CLOSE, DIRECTORY_UNSET, matchSpecDriftChoice, SPEC_DRIFT_LABELS, specDriftQuestion, SPEC_DRIFT_QUESTION_ID } = await import('../src/injection.ts')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const project = (title, directories) => ({
  title,
  directories,
  docPath: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

/**
 * Render with the document feature off.
 *
 * The renderer takes one input object now — the project plus the optional
 * document lines — so every assertion about the project half states that the
 * document half is absent rather than passing a bare record.
 * @param value - the project record, or undefined when unfiled.
 * @returns the rendered contribution.
 */
const render = (value) => renderProjectInjection({ project: value })

console.log('=== renderer: the block the model reads ===')

// The declaration paragraph, written out here as the expected text rather than
// derived from the renderer: this is the spec for the wording, so copying it from
// the implementation would make the assertion vacuous.
const DECLARATION_TAIL = 'Project membership is classified by the plugin layer; the plugin does not modify '
  + "the official workspace system, so all projects' workspace directories fall into a single base "
  + 'workspace. The "working directory" injected in the earlier system prompt is the official base '
  + 'workspace directory, and has no substantive relation to the project this session belongs to '
  + 'under this plugin.'
const decl = (segments) => 'This section is injected by the `project-groups` plugin. It provides '
  + `context information about the session's ${segments}. ${DECLARATION_TAIL}`

// The unfiled case states that there is no project. It is a sentence, not the
// filed template with an empty slot: `project name "none (ungrouped)"` would
// assert a project that does not exist.
{
  const text = render(undefined)
  check('an unfiled Session says it belongs to no project',
    text.includes('Owning project: This conversation does not belong to any project. '
      + 'It is under the "Ungrouped" category.'), JSON.stringify(text))
  // `directories` is a field of the project record and an unfiled Session has no
  // record, so the line would name a setting with no editing surface.
  check('an unfiled Session carries no directory line',
    !text.includes('Relevant directory'), JSON.stringify(text))
  check('an unfiled block is framed',
    text.startsWith(`${PROJECT_CONTEXT_OPEN}\n`) && text.endsWith(`\n${PROJECT_CONTEXT_CLOSE}`),
    JSON.stringify(text))
}

// A filed project WITH no directories keeps its line: that project does have an
// edit surface, so the unset sentence is actionable rather than absent.
{
  const text = render(project('项目一', []))
  check('a filed project with no directories points at the unset state',
    text.includes(`Relevant directory: ${DIRECTORY_UNSET}`), JSON.stringify(text))
}

// ONE directory takes the SINGULAR label and no list. The design settled on the
// label following the count; a plural heading above a single path reads as a
// truncated list.
{
  const text = render(project('项目一', ['C:\\work']))
  check('a single directory uses the singular label and no list',
    text.includes('Relevant directory: C:\\work')
    && !text.includes('Relevant directories:'), JSON.stringify(text))
}

// Several directories take the plural label, keep their order, and still use plain
// dashes — the block's only markup stays the frame.
{
  const text = render(project('项目一', ['C:\\a', 'D:\\b', 'E:\\c']))
  check('several directories use the plural label, in order',
    text.includes('Relevant directories:\n- C:\\a\n- D:\\b\n- E:\\c'), JSON.stringify(text))
}

// A project record carrying a `docPath` does NOT make the renderer emit a
// document line: the lines come from the `document` input, which the Host builds
// only when the document switch is on. A record field must not leak into the
// block on its own.
{
  const text = render({ ...project('项目一', ['C:\\a']), docPath: 'C:\\doc.md' })
  check('a docPath on the record alone renders no document line',
    !text.includes('Project document'), JSON.stringify(text))
}

console.log('\n=== renderer: the declaration and its segment list ===')

// Declared here because the segment list depends on them: a document input is what
// adds the `work document` segment, so the sample must exist before it is asserted.
const DOC = 'C:\\Users\\Someone\\.dsh\\project-groups\\p1.md'
const SPEC = 'C:\\Users\\Someone\\.dsh\\project-groups\\specs\\team-spec.md'
const BUILT_IN = 'C:\\pkg\\spec\\PROJECT-SPEC.md'

/** Render with the document feature on. */
const withDoc = (document) => renderProjectInjection({ project: project('项目一', ['C:\\a']), document })

// The declaration names each segment only while it can be rendered, so it never
// promises a field the block does not carry. `related links` is reserved for a
// feature that does not exist yet, so announcing it would send the model looking
// for a value that is always absent.
{
  const unfiled = render(undefined)
  check('unfiled announces only the owning project',
    unfiled.includes(decl('`owning project`')), JSON.stringify(unfiled))

  const filed = render(project('项目一', []))
  check('a filed project announces its directories too',
    filed.includes(decl('`owning project` `relevant directories`')), JSON.stringify(filed))

  const documented = withDoc({ docPath: DOC, specMode: 'none' })
  check('the document feature adds its segment to the declaration',
    documented.includes(decl('`owning project` `relevant directories` `work document`')),
    JSON.stringify(documented))

  check('a reserved segment is never announced',
    !filed.includes('related links') && !documented.includes('related links'),
    JSON.stringify(filed))
}

// The frame is what bounds a block that now carries user-supplied names and paths.
// Asserted as the boundary itself: counting `<` would pass on any markup at all.
{
  const text = render(project('p', ['C:\\a']))
  check('the block opens with the frame and closes with it',
    text.startsWith(`${PROJECT_CONTEXT_OPEN}\n`) && text.endsWith(`\n${PROJECT_CONTEXT_CLOSE}`),
    JSON.stringify(text))
  check('the frame appears exactly once at each end',
    text.split(PROJECT_CONTEXT_OPEN).length === 2
    && text.split(PROJECT_CONTEXT_CLOSE).length === 2, JSON.stringify(text))
  check('the declaration is the first content inside the frame',
    text.split('\n')[1] === decl('`owning project` `relevant directories`'), JSON.stringify(text))
}

// The unreachable combination, pinned so a refactor cannot quietly allow it: a
// document hangs off a project record, so an unfiled Session has none. This was
// asserted wrongly once, which is why it is a test rather than a comment.
{
  const text = renderProjectInjection({
    project: undefined,
    document: { docPath: DOC, specMode: 'default', specPath: BUILT_IN },
  })
  check('an unfiled Session renders no document even when one is passed',
    !text.includes('Project document'), JSON.stringify(text))
}

console.log('\n=== renderer: the document lines ===')

// The common case: a spec exists, and the line tells the model what a failed
// read means without the plugin ever touching the filesystem.
{
  const text = withDoc({ docPath: DOC, specMode: 'default', specPath: BUILT_IN })
  check('the document line names the document and the read rule',
    text.includes(`Project document: ${DOC} — a failed read means it has not been created yet; create it following the spec.`),
    JSON.stringify(text))
  check('the spec line names the spec path',
    text.includes(`Project document spec: ${BUILT_IN}`), JSON.stringify(text))
}

// No spec: there is no procedure to follow, so the instruction must not promise
// one — it says "as the project needs" instead.
{
  const text = withDoc({ docPath: DOC, specMode: 'none' })
  check('with no spec the read rule drops the spec reference',
    text.includes(`${DOC} — a failed read means it has not been created yet; create it as the project needs.`),
    JSON.stringify(text))
  // The wording states the POLICY, not just the absence of a format: "no format
  // is required" alone can be read as "rewrite it however you like", which would
  // license reorganising a document that already has a structure.
  check('with no spec the spec line states the no-update policy',
    text.includes("no format is required, and the document's format is left as it is"),
    JSON.stringify(text))
  check('...and says a structured document is added to, not reorganised',
    text.includes('rather than reorganising the document'), JSON.stringify(text))
}

// 无 never asks the drift question: migration needs a target spec, and there is
// none. The prompt points the model at the spec file AND at `REWRITE-FLOW.md`,
// whose first step is to read "the spec file given in this injection" — so asking
// here instructs it to restructure a document to follow a spec that does not
// exist. That was the reported contradiction.
//
// `shouldAskSpecDrift` is the guard itself, extracted so this can be asserted
// directly: the effect of the bug is an ABSENCE (no drift text appears), which
// the rendered-text assertions above cannot distinguish from "correct".
{
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  // The bug: a document written under a spec, then the choice moves to 无.
  check('no spec ⇒ no drift question, even for a written document',
    shouldAskSpecDrift({ usedSha1: A, ignoredSha1: undefined, currentSha1: undefined }) === false)
  // ...including when the user had previously dismissed another spec.
  check('no spec ⇒ no drift question even with a dismissal recorded',
    shouldAskSpecDrift({ usedSha1: A, ignoredSha1: B, currentSha1: undefined }) === false)
  // A document that has never been written has nothing to migrate FROM.
  check('an unwritten document never asks',
    shouldAskSpecDrift({ usedSha1: undefined, ignoredSha1: undefined, currentSha1: A }) === false)
  // The real migration: the spec content changed.
  check('a changed spec asks',
    shouldAskSpecDrift({ usedSha1: A, ignoredSha1: undefined, currentSha1: B }) === true)
  // Already aligned.
  check('an aligned document stays silent',
    shouldAskSpecDrift({ usedSha1: A, ignoredSha1: undefined, currentSha1: A }) === false)
  // Dismissed for exactly this content.
  check('a dismissal for this content stays silent',
    shouldAskSpecDrift({ usedSha1: A, ignoredSha1: B, currentSha1: B }) === false)
  // A dismissal for OTHER content does not silence a new spec — the whole point
  // of storing a hash instead of a boolean.
  check('a dismissal for other content still asks',
    shouldAskSpecDrift({ usedSha1: A, ignoredSha1: A, currentSha1: B }) === true)
  // The round trip: 无 → back to the SAME spec is not a change, so it stays
  // silent. `docSpecUsed` is deliberately left untouched while the choice is 无.
  check('returning to the same spec after 无 stays silent',
    shouldAskSpecDrift({ usedSha1: A, ignoredSha1: undefined, currentSha1: A }) === false)
}

// Drift: the block asks for a question and points at the rewrite procedure. The
// document line loses its trailing sentence, because drift is only reported for a
// document that already exists.
{
  const text = withDoc({
    docPath: DOC, specMode: 'custom', specPath: SPEC,
    drift: { locale: 'zh', rewriteFlowPath: 'C:\\pkg\\spec\\REWRITE-FLOW.md' },
  })
  check('drift drops the read-failure sentence',
    text.includes(`Project document: ${DOC}\n`), JSON.stringify(text))
  check('drift asks for the exact tool and id',
    text.includes('call `ask_user_question`') && text.includes(`id: ${SPEC_DRIFT_QUESTION_ID}`),
    JSON.stringify(text))
  check('drift points at the rewrite procedure',
    text.includes('C:\\pkg\\spec\\REWRITE-FLOW.md'), JSON.stringify(text))
  check('drift asks for strict verbatim use, forbidding translation',
    text.includes('strictly verbatim') && text.includes('do not rewrite or translate'), JSON.stringify(text))
}

// The locale switches ONLY the question and option labels. Every framework
// sentence stays English, which is what keeps the block readable to the model.
{
  const zh = withDoc({ docPath: DOC, specMode: 'default', specPath: BUILT_IN, drift: { locale: 'zh', rewriteFlowPath: 'F' } })
  const en = withDoc({ docPath: DOC, specMode: 'default', specPath: BUILT_IN, drift: { locale: 'en', rewriteFlowPath: 'F' } })
  check('zh renders the Chinese labels',
    zh.includes(SPEC_DRIFT_LABELS.rewrite.zh) && zh.includes(SPEC_DRIFT_LABELS.skip.zh)
    && zh.includes(SPEC_DRIFT_LABELS.ignore.zh), JSON.stringify(zh.slice(-260)))
  check('en renders the English labels',
    en.includes(SPEC_DRIFT_LABELS.rewrite.en) && en.includes(SPEC_DRIFT_LABELS.skip.en)
    && en.includes(SPEC_DRIFT_LABELS.ignore.en), JSON.stringify(en.slice(-260)))
  check('the framework sentences are identical in both locales',
    zh.replace(SPEC_DRIFT_LABELS.rewrite.zh, '').replace(SPEC_DRIFT_LABELS.skip.zh, '')
      .replace(SPEC_DRIFT_LABELS.ignore.zh, '').includes('Before continuing, call `ask_user_question`')
    && en.includes('Before continuing, call `ask_user_question`'))
  check('the option descriptions are localized too',
    zh.includes('已有信息不丢失') && en.includes('no information is lost'))
}

// Exact-match recognition, in both languages, and a wrong label matching nothing.
{
  for (const [choice, labels] of Object.entries(SPEC_DRIFT_LABELS)) {
    check(`"${choice}" matches its Chinese label`, matchSpecDriftChoice(labels.zh) === choice, labels.zh)
    check(`"${choice}" matches its English label`, matchSpecDriftChoice(labels.en) === choice, labels.en)
  }
  check('a rewritten label matches nothing',
    matchSpecDriftChoice('按新规范重写文档') === undefined
    && matchSpecDriftChoice('Rewrite the document') === undefined
    && matchSpecDriftChoice('') === undefined)
  check('a recommended-suffix label matches nothing',
    matchSpecDriftChoice(`${SPEC_DRIFT_LABELS.rewrite.zh} (Recommended)`) === undefined)
  check('the question carries exactly three options',
    specDriftQuestion('zh').options.length === 3
    && specDriftQuestion('en').options.length === 3)
}

// The fields and the declaration are English, and the block's only markup is its
// frame. A regression to the earlier Chinese labels, or to an XML *list* inside the
// frame, would both be drift away from the design.
//
// The frame itself is asserted above. This check is the other half: the fields
// inside it use the `<label>: value` form that every official `context()`
// contribution uses, so the frame bounds prose rather than replacing it.
{
  const text = render(project('p', ['C:\\a']))
  check('the fields are English and use the plain label form',
    text.includes('Owning project: ') && text.includes('Relevant directory: '),
    JSON.stringify(text))
  check('the only markup is the frame',
    text.replaceAll(PROJECT_CONTEXT_OPEN, '').replaceAll(PROJECT_CONTEXT_CLOSE, '').includes('<') === false,
    JSON.stringify(text))
  check('the dirs list uses plain dashes, not an XML list',
    render(project('p', ['C:\\a', 'D:\\b'])).includes('\n- C:\\a\n- D:\\b'), JSON.stringify(text))
}

// Every render is non-empty: the caller relies on that to decide it has content.
{
  check('a render is never empty',
    render(undefined).length > 0
    && render(project('x', [])).length > 0)
}

// For a FILED project the shape depends only on the directory count, so the model
// sees the same block regardless of which project it is. The counts include the
// frame (2 lines), the declaration (1) and a blank line before the frame's close.
{
  const lines = (text) => text.split('\n').length
  check('a filed block’s shape depends only on the directory count',
    lines(render(project('a', []))) === 6
    && lines(render(project('b', []))) === 6
    && lines(render(project('a', ['x']))) === 6
    && lines(render(project('b', ['y', 'z']))) === 8)
  check('the unfiled block is shorter than any filed block',
    lines(render(undefined)) === 5)
}

console.log('\n=== lineage walk: subagent sessions resolve to the parent’s project ===')

/**
 * The walk under test, transcribed from `ProjectController.projectOfSession`.
 * @param assignments - session id → owning project id (the durable table).
 * @param sessions - the live Session store face (`get` returns a live Session).
 * @param sessionId - the Session to resolve.
 */
function projectOfSession({ assignments, sessions, sessionId }) {
  const direct = assignments.get(sessionId)
  if (direct !== undefined) return direct

  let header = sessions.get(sessionId)?.header
  if (header === undefined) return undefined
  if (header.origin !== 'subagent') return undefined

  const visited = new Set([sessionId])
  while (header.parentSession !== undefined) {
    const parentId = header.parentSession
    if (visited.has(parentId)) return undefined
    visited.add(parentId)
    const filed = assignments.get(parentId)
    if (filed !== undefined) return filed
    const parent = sessions.get(parentId)
    if (parent === undefined) return undefined
    header = parent.header
    if (header.origin !== 'subagent') return undefined
  }
  return undefined
}

const live = (id, header) => ({ id, header: { id, ...header } })
const walk = (assignments, sessions, sessionId) =>
  projectOfSession({ assignments: new Map(assignments), sessions: new Map(sessions), sessionId })

// Ordinary filed session: direct hit, the walk does not start.
check('a filed ordinary session resolves directly',
  walk([['s1', 'P1']], [['s1', live('s1', {})]], 's1') === 'P1')

// Ordinary UNfiled session whose parent is filed: a fork is its own conversation,
// so it must NOT inherit.
check('an ordinary session does not inherit its parent project',
  walk([['parent', 'P1']], [['child', live('child', { parentSession: 'parent' })]], 'child') === undefined)

// One level down.
check('a subagent inherits its parent project',
  walk(
    [['parent', 'P1']],
    [['parent', live('parent', {})], ['child', live('child', { origin: 'subagent', parentSession: 'parent' })]],
    'child',
  ) === 'P1')

// Multi-level: the grandparent is the first filed rung.
check('the walk crosses multiple levels',
  walk(
    [['root', 'P-root']],
    [
      ['root', live('root', {})],
      ['mid', live('mid', { origin: 'subagent', parentSession: 'root' })],
      ['leaf', live('leaf', { origin: 'subagent', parentSession: 'mid' })],
    ],
    'leaf',
  ) === 'P-root')

// The nearest filed ancestor wins, not the root.
check('the nearest filed ancestor wins',
  walk(
    [['root', 'P-root'], ['mid', 'P-mid']],
    [
      ['root', live('root', {})],
      ['mid', live('mid', { origin: 'subagent', parentSession: 'root' })],
      ['leaf', live('leaf', { origin: 'subagent', parentSession: 'mid' })],
    ],
    'leaf',
  ) === 'P-mid')

// A filed-but-CLOSED ancestor is still readable: `assignments` is durable and the
// id survives in the child's header. This is the case the design first got wrong.
check('a filed-but-closed ancestor is still found',
  walk([['gone', 'P1']], [['orphan', live('orphan', { origin: 'subagent', parentSession: 'gone' })]], 'orphan') === 'P1')

// A closed ancestor that is itself unfiled blocks the climb: its own parent id
// rides on a header we cannot read, so the walk stops rather than guessing.
check('a closed unfiled ancestor stops the walk',
  walk([['grand', 'P-top']], [['leaf2', live('leaf2', { origin: 'subagent', parentSession: 'mid' })]], 'leaf2') === undefined)

// A cycle terminates instead of hanging.
check('a cyclic lineage terminates',
  walk(
    [],
    [
      ['a', live('a', { origin: 'subagent', parentSession: 'b' })],
      ['b', live('b', { origin: 'subagent', parentSession: 'a' })],
    ],
    'a',
  ) === undefined)

// A session the store does not know: nothing to walk from.
check('an unknown session resolves to nothing',
  walk([], [], 'ghost') === undefined)

// The walk is synchronous all the way down — a Promise would break `text()`.
{
  const result = walk(
    [['parent', 'P1']],
    [['parent', live('parent', {})], ['child', live('child', { origin: 'subagent', parentSession: 'parent' })]],
    'child',
  )
  check('the walk returns a plain value, never a promise', typeof result === 'string')
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)

