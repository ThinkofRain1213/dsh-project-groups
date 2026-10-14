/**
 * Behaviour test for the locale maps.
 *
 * A missing key is invisible at runtime: the lookup returns `undefined`, React
 * renders nothing, and every existing probe still passes because they assert on
 * the strings they DO expect. It reached a release-shaped state once already —
 * three keys were defined in both languages and referenced nowhere, and two of
 * them were leftovers of a design that had been deleted.
 *
 * Three checks, in order of how much damage the failure does:
 *
 *   1. **Parity** — a key in one language but not the other. The worst of the
 *      three, because the UI is then half-translated in exactly one locale.
 *   2. **Dead keys** — defined, never referenced. Not a user-visible bug, but it
 *      is how a removed design keeps looking alive, and the next reader has to
 *      re-derive whether the key still matters.
 *   3. **Placeholders** — `{name}`-style slots must match across languages, or one
 *      locale interpolates a value the other silently drops.
 *
 * Both maps are read from source rather than imported, because they are plain
 * object literals inside modules that also import React and CSS; parsing them
 * keeps this test runnable without the client bundle.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Every `.ts`/`.tsx` under a directory, excluding build output. */
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'lib') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** `{slot}` names inside one message. */
const slotsOf = (text) => new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]))

/** The two dictionaries themselves, which must not be part of their own reference corpus. */
const DICTIONARIES = [
  join('src', 'client', 'settings-locales.ts'),
  join('src', 'vendored', 'client', 'locales.ts'),
]

/**
 * The corpus every dead-key lookup searches: every `.ts`/`.tsx` under `src` **except the
 * dictionaries themselves**.
 *
 * Leaving them in is what made the check vacuous. A key is "dead" when no file references its
 * literal — but the dictionary that *defines* every key contains all of those literals, so
 * `corpus.includes("'key'")` was true for every key and the check could never fail. It reported
 * 0 dead keys for 154 of them, which is not the same as there being none.
 *
 * Read once here rather than re-joined per `compare` call (there are two of them).
 */
const CORPUS = sources('src')
  .filter(file => !DICTIONARIES.includes(file))
  .map(file => readFileSync(file, 'utf8'))
  .join('\n')

/**
 * Key prefixes that the corpus builds at runtime, e.g. ``t(`archive.confirm.jobs.${plural}`)``.
 *
 * A literal-substring search cannot see those, so every member of such a family would be
 * reported dead — ten keys in the browser dictionary are built this way, plus `time.${unit}`.
 *
 * Scoped to a `t(` call on purpose. Matching any template literal collected `remote.`` too,
 * which is a service name rather than a locale prefix, and an excused prefix is a key the check
 * can no longer report.
 */
const DYNAMIC_PREFIXES = [...new Set(
  [...CORPUS.matchAll(/\bt\(`([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\.\$\{/g)].map(m => `${m[1]}.`),
)]

/**
 * Keys that are unreferenced in this repository for a reason, with the reason.
 *
 * The check is only useful if a failure means "delete this key", so every exception is listed
 * rather than the rule being weakened. Two of these were established by reading the **official
 * bundle** out of the installed DSH's `app.asar` — the same source `compare-bundle.mjs` uses —
 * because "unused here" and "unused" are different claims: this tree vendors a subset of
 * upstream, and a key whose only consumer was not vendored would otherwise be deleted and break
 * upstream.
 */
const LICENSED_UNREFERENCED = new Map([
  // Measured: 2 occurrences in the official client bundle. Its consumer is not in this tree.
  ['empty.noMatches', '官方 bundle 引用 2 次；其消费组件未 vendored'],
  // Measured: 2 occurrences each. Same reason.
  ['sessions.count.one', '官方 bundle 引用 2 次；其消费组件未 vendored'],
  ['sessions.count.other', '官方 bundle 引用 2 次；其消费组件未 vendored'],
  // Measured: 0 occurrences upstream either — this one really is unused, and is kept on purpose.
  ['rename.project.title', '有意保留：见 locales.ts 中「for the Workspace-side dictionary symmetry」'],
])

/**
 * Compare one locale pair.
 *
 * `zhMarker` / `enMarker` locate the two object literals; the second runs to the
 * end of the file. Keys are matched on `  name:` at two-space indent, which is how
 * both files are written.
 */
function compare({ label, file, zhMarker, enMarker, flat }) {
  console.log('')
  console.log(`=== ${label} ===`)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    // Named rather than thrown. A renamed or moved dictionary used to abort the whole script
    // with a raw ENOENT stack and no indication that this was the file being checked.
    check(`${label}: 可以读取 ${file}`, false, String(error.message ?? error).slice(0, 160))
    return
  }
  // Anchored to the start of a line. The markers used to be plain `indexOf` substrings, so a
  // marker mentioned in a comment above the declaration would split the file at the wrong
  // place and the two bodies would then be nonsense — reported as a parity failure rather than
  // as the parse problem it is.
  const zhMatch = new RegExp(`^${zhMarker}`, 'm').exec(text)
  const enMatch = zhMatch === null ? null : new RegExp(`^${enMarker}`, 'm').exec(text.slice(zhMatch.index))
  const zhStart = zhMatch?.index ?? -1
  const enStart = enMatch === null || zhMatch === null ? -1 : zhMatch.index + enMatch.index
  if (zhStart < 0 || enStart < 0) {
    check(`${label}: 找到两个语言块`, false, `zh=${zhStart} en=${enStart}`)
    return
  }
  const zhBody = text.slice(zhStart, enStart)
  const enBody = text.slice(enStart)

  // Flat maps are `'a.b': value`; nested ones are `  name: value`.
  //
  // The value may be quoted with EITHER quote character: several English strings
  // contain an apostrophe ("The current Session's project") and are therefore
  // double-quoted, while their Chinese counterparts are single-quoted. Matching
  // only `'...'` reported those as missing from `en` — three false failures that
  // looked exactly like a real parity bug.
  const value = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`
  const re = flat
    ? new RegExp(String.raw`^\s{2}'([^']+)'\s*:\s*${value}`, 'gm')
    : new RegExp(String.raw`^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:\s*${value}`, 'gm')
  const grab = (body) => {
    const out = new Map()
    for (const m of body.matchAll(re)) out.set(m[1], m[2] ?? m[3] ?? '')
    return out
  }
  const zh = grab(zhBody)
  const en = grab(enBody)
  console.log(`  ${label}: zh=${zh.size} en=${en.size}`)

  // The extractor above understands single/double-quoted single-line values and nothing else.
  // Rather than silently skipping any other form — which would make the key look absent from
  // the language it is present in, i.e. a false parity failure — assert that no other form
  // exists. Measured: none does today (the only backticks in either dictionary are inside
  // comments).
  const unsupported = [...`${zhBody}\n${enBody}`.matchAll(
    /^\s{2}(?:'[^']+'|[A-Za-z][A-Za-z0-9_]*)\s*:\s*[`[]/gm,
  )].map(m => m[0].trim())
  check(`${label}: 没有解析器不支持的取值形式`, unsupported.length === 0,
    JSON.stringify(unsupported.slice(0, 4)))

  // 1. Parity.
  const onlyZh = [...zh.keys()].filter(k => !en.has(k))
  const onlyEn = [...en.keys()].filter(k => !zh.has(k))
  check(`${label}: 两个语言键位一致`, onlyZh.length === 0 && onlyEn.length === 0,
    `只在 zh: ${JSON.stringify(onlyZh)} / 只在 en: ${JSON.stringify(onlyEn)}`)

  // 3. Placeholder parity.
  const slotMismatch = []
  for (const [key, zhText] of zh) {
    const enText = en.get(key)
    if (enText === undefined) continue
    const a = [...slotsOf(zhText)].sort().join(',')
    const b = [...slotsOf(enText)].sort().join(',')
    if (a !== b) slotMismatch.push(`${key}: zh{${a}} en{${b}}`)
  }
  check(`${label}: 占位符两侧一致`, slotMismatch.length === 0, slotMismatch.join(' | '))

  // 2. Dead keys: defined in zh, never referenced by any source file.
  //
  // Three things count as referenced: the literal appears in the corpus, the key belongs to a
  // family the corpus builds at runtime (`t(\`a.b.${plural}\`)`), or it is listed in
  // `LICENSED_UNREFERENCED` with a reason. `CORPUS` excludes the dictionaries — see its own
  // note on why leaving them in made this check incapable of failing.
  const referenced = (key) => CORPUS.includes(`'${key}'`) || CORPUS.includes(`"${key}"`)
  const dynamic = (key) => DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix))
  const dead = [...zh.keys()].filter(key => !referenced(key) && !dynamic(key) && !LICENSED_UNREFERENCED.has(key))
  check(`${label}: 无死键`, dead.length === 0, JSON.stringify(dead))
}

const srcFiles = sources('src')
console.log('')
console.log(`  引用语料：${srcFiles.length - DICTIONARIES.length} 个源文件（已排除字典自身）`)
console.log(`  运行时构造的键前缀：${DYNAMIC_PREFIXES.length} 个${DYNAMIC_PREFIXES.length === 0 ? '' : ` — ${DYNAMIC_PREFIXES.join(', ')}`}`)
compare({
  label: '设置卡',
  file: join('src', 'client', 'settings-locales.ts'),
  // Anchored declaration regexes, not substrings: the declarations are `export const zh = {`
  // and `export const en: Record<…> = {`, so a bare `const zh = {` substring only matched by
  // accident and would have stopped matching the moment `export` moved.
  zhMarker: 'export const zh = \\{',
  enMarker: 'export const en',
  flat: false,
})
compare({
  label: '浏览器',
  file: join('src', 'vendored', 'client', 'locales.ts'),
  zhMarker: 'export const zh',
  enMarker: 'export const en',
  flat: true,
})

// The archived notice is assembled from four locale fragments at render time.
//
// `Toast` takes `text: string` and actions of `{ prefix, label }`, rendering them flowing as one
// sentence — so this is the primitive's contract and a single parameterized sentence is not
// expressible here. The consequence is that the concatenation depends on whitespace embedded in
// the **data**: English needs a trailing space on `toast.archived` and spaces around
// `toast.archivedOr`, Chinese needs neither.
//
// Nothing about reading one key reveals whether that spacing is right, and trimming or
// reordering the fragments breaks the sentence silently. Asserting the assembled result is what
// makes it visible. Imported rather than parsed from source (unlike the checks above) because
// `locales.ts` imports nothing — it is a plain object literal — so it loads without the client
// bundle the comment at the top of this file is avoiding.
{
  const { zh: browserZh, en: browserEn } = await import('../src/vendored/client/locales.ts')
  const assemble = (dict, textKey) => [
    dict[textKey], dict['toast.archivedUndo'], dict['toast.archivedOr'], dict['toast.archivedFilter'],
  ].join('')

  check('浏览器: 归档提示拼出的中文句子通顺',
    assemble(browserZh, 'toast.archived') === '会话已归档，可撤销或筛选已归档会话',
    assemble(browserZh, 'toast.archived'))
  check('浏览器: 归档提示拼出的英文句子通顺',
    assemble(browserEn, 'toast.archived') === 'Session archived. You can undo or filter archived sessions',
    assemble(browserEn, 'toast.archived'))
  // The sibling notice shares the three action fragments, so it needs the same check rather
  // than being assumed to follow.
  check('浏览器: 停止并归档的英文句子通顺',
    assemble(browserEn, 'toast.stoppedAndArchived')
      === 'Session stopped and archived. You can undo or filter archived sessions',
    assemble(browserEn, 'toast.stoppedAndArchived'))
  check('浏览器: 停止并归档的中文句子通顺',
    assemble(browserZh, 'toast.stoppedAndArchived') === '已停止并归档，可撤销或筛选已归档会话',
    assemble(browserZh, 'toast.stoppedAndArchived'))
  // A doubled space is the specific way this goes wrong after an edit, and it survives a
  // sentence-level read of the source.
  for (const [label, sentence] of [['zh', assemble(browserZh, 'toast.archived')], ['en', assemble(browserEn, 'toast.archived')]]) {
    check(`浏览器: ${label} 片段拼接后无双空格`, !sentence.includes('  '), JSON.stringify(sentence))
  }
}

// A licence for a key that no longer exists is itself a defect: it silently widens the
// exemption for whatever key is added next, and it hides the fact that a key was deleted
// without deleting its justification. Checked once across both dictionaries, not per
// dictionary — `empty.noMatches` lives in the browser map only.
{
  const defined = new Set()
  for (const file of DICTIONARIES) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/^\s{2}'([^']+)'\s*:/gm)) defined.add(m[1])
  }
  const stale = [...LICENSED_UNREFERENCED.keys()].filter(key => !defined.has(key))
  console.log('')
  check('豁免表中的键仍然存在', stale.length === 0, JSON.stringify(stale))
}

console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
