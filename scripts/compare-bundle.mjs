/**
 * Compare this plugin's client bundle against the official one it vendors.
 *
 * The plugin owns the sidebar by vendoring the official workspace browser, so
 * at this stage the two artifacts must agree on every fact that decides whether
 * the bundle can even load:
 *
 *   - the loader id it registers under;
 *   - the externals it resolves through the shell's module table (a specifier
 *     the table cannot answer is a guaranteed runtime throw);
 *   - that it publishes the same `apply` / `inject` surface;
 *   - that no build-machine checkout path leaked into the artifact (which would
 *     break byte-stable rebuilds across machines).
 *
 * The official bundle is read from the installed DSH's `app.asar` so the
 * comparison is against the real shipped artifact, not a checked-in copy. Pass
 * a path explicitly to compare against something else.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findInstalledAsar, readAsarFile } from './lib/asar.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUR_ID = 'dsh-project-groups'
const OFFICIAL_ID = '@deepseek-ai/dsh-client-ui-workspace'
const OFFICIAL_ENTRY = `/dsh/node_modules/${OFFICIAL_ID}/lib/client.js`

/**
 * Read a required artifact, or exit with the same kind of diagnostic the no-asar case gets.
 *
 * These reads were bare. A missing or misnamed file — the ordinary consequence of not having run
 * `pnpm build`, or of a renamed output — surfaced as an uncaught `ENOENT` stack trace, while the
 * *absent-asar* case below already exited 2 with a sentence. Same class of problem, one of them
 * reported properly.
 * @param path - the file to read.
 * @param what - how to describe it in the error message.
 * @returns the file's text.
 */
const readRequired = (path, what) => {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch (error) {
    console.error(`cannot read the ${what} at ${path}: ${error.message}`)
    console.error('if this is our own bundle, run `pnpm build` first')
    process.exit(2)
  }
}

const ours = readRequired(join(root, 'lib/client.js'), 'built client bundle')

let official
const explicit = process.argv[2]
if (explicit !== undefined) {
  official = readRequired(explicit, 'client bundle given as an argument')
  console.log(`official source: ${explicit}`)
} else {
  const asar = findInstalledAsar()
  if (asar === undefined) {
    console.error('no installed DSH found; pass the official client.js path as an argument')
    process.exit(2)
  }
  try {
    official = readAsarFile(asar, OFFICIAL_ENTRY)
  } catch (error) {
    console.error(`cannot read ${OFFICIAL_ENTRY} from ${asar}: ${error.message}`)
    process.exit(2)
  }
  console.log(`official source: ${asar}${OFFICIAL_ENTRY}`)
}
console.log('')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** Any quoted form, because a minifier or a config change may switch the quoting style. */
const QUOTED = `["'\`]([^"'\`]+)["'\`]`

/**
 * The external specifiers a bundle resolves through the shell's module table, plus whether the
 * extraction found any at all.
 *
 * `require("...")` only matched double-quoted specifiers, so a switch to single quotes would have
 * yielded an *empty* list — and two empty lists compare equal, which would turn the "same externals"
 * check into a silent pass. Returning the count lets the caller assert the extraction worked before
 * trusting the comparison.
 */
const externalsOf = (src) => {
  const found = [...new Set([...src.matchAll(new RegExp(`require\\(${QUOTED}\\)`, 'g'))].map(m => m[1]))].sort()
  return { list: found, count: found.length }
}

/**
 * The loader id a bundle registers under, or `undefined`.
 *
 * The old pattern assumed `{ id: "..." }`, double-quoted and exactly spaced. It is laxer now, but
 * the caller still asserts the result — a pattern that silently stops matching must not read as
 * agreement between two bundles.
 */
const idOf = (src) => src.match(new RegExp(`__ModuleLoader__\\.load\\(\\s*\\{[^}]*?id:\\s*${QUOTED}`))?.[1]

/**
 * The `exports.inject` list of a bundle, resolved through one level of variable reference.
 *
 * Neither artifact writes the array inline: both do `exports.inject = inject;`, so a regex for
 * `exports.inject = [...]` matches nothing in either — and comparing two `undefined`s is how the
 * check this replaces came to pass while reading nothing. Resolving the referenced binding finds
 * the real list (the official bundle emits it above the assignment; ours re-exports the vendored
 * binding).
 *
 * Returns `undefined` when the value cannot be resolved, which the caller reports as unverified
 * rather than as agreement.
 * @param src - the bundle source.
 * @returns the whitespace-stripped list, or `undefined`.
 */
const injectOf = (src) => {
  const inline = /exports\.inject\s*=\s*\[([^\]]*)\]/.exec(src)?.[1]
  if (inline !== undefined) return inline.replace(/\s/g, '')
  const name = /exports\.inject\s*=\s*([A-Za-z_$][\w$]*)\s*;/.exec(src)?.[1]
  if (name === undefined) return undefined
  const escaped = name.replace(/\$/g, '\\$')
  const def = new RegExp(`(?:const|var|let)\\s+${escaped}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src)?.[1]
    // `export const inject = vendoredInject` chains one hop further in ours.
    ?? (() => {
      const alias = new RegExp(`(?:const|var|let)\\s+${escaped}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;`).exec(src)?.[1]
      if (alias === undefined) return undefined
      const chain = alias.replace(/\$/g, '\\$')
      return new RegExp(`(?:const|var|let)\\s+${chain}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src)?.[1]
    })()
  return def === undefined ? undefined : def.replace(/\s/g, '')
}

/**
 * Where a value was built on a developer's machine rather than reproducibly.
 *
 * The Windows form was the only one checked, so a POSIX or CI checkout path slipped through and the
 * byte-stable-rebuild guarantee this check exists to enforce was not actually verified on those
 * machines.
 *
 * One **alternation**, not a list of patterns to run in turn: a single left-to-right scan continues
 * after the end of each match, so `/home/runner/proj` is reported once as a home path rather than
 * again as a CI path. Running several patterns and concatenating their hits reported the same path
 * twice, which reads like two separate leaks.
 */
const MACHINE_PATH_PATTERN = new RegExp([
  String.raw`[A-Za-z]:\\+Users\\+[^\\\s"']+`,             // Windows checkout: C:\Users\<name>
  String.raw`\/(?:home|Users)\/[^/\s"']+(?:\/[^/\s"']+)*`, // POSIX / macOS home, whole path
  String.raw`\/(?:builds|runner|github\/workspace)\/[^/\s"']+`, // common CI roots
].join('|'), 'gi')

const ourExternals = externalsOf(ours)
const officialExternals = externalsOf(official)

// The extractions are asserted before anything is compared. Without this a pattern that stops
// matching makes two artifacts "agree" on nothing at all.
check('found this bundle\'s loader id', idOf(ours) !== undefined, String(idOf(ours)))
check('found the official bundle\'s loader id (sanity check)',
  idOf(official) !== undefined, String(idOf(official)))
check('extracted externals from both bundles',
  ourExternals.count > 0 && officialExternals.count > 0,
  `ours=${String(ourExternals.count)} official=${String(officialExternals.count)}`)

check('registers under this plugin\'s own id', idOf(ours) === OUR_ID, String(idOf(ours)))
check('official registers under its own id (sanity check)',
  idOf(official) === OFFICIAL_ID, String(idOf(official)))
check('resolves the SAME externals as the official bundle',
  JSON.stringify(ourExternals.list) === JSON.stringify(officialExternals.list),
  `ours=${JSON.stringify(ourExternals.list)} official=${JSON.stringify(officialExternals.list)}`)
check('publishes apply', /exports\.apply\s*=/.test(ours))
check('publishes inject', /exports\.inject\s*=/.test(ours))

// Reported as **not verified** rather than as agreement.
//
// Both bundles write `exports.inject = inject;`, so neither has an array literal to extract. The
// previous form compared `undefined` to `undefined` and passed, printing a detail line of
// `undefined` — a check that could not fail, which is worse than no check because it reads as
// evidence. If a future build starts emitting a literal, the comparison runs for real.
const ourInject = injectOf(ours)
const officialInject = injectOf(official)
const canCompareInject = ourInject !== undefined && officialInject !== undefined
if (canCompareInject) {
  check('declares the same injected services as the official bundle',
    ourInject.replace(/\s/g, '') === officialInject.replace(/\s/g, ''),
    ourInject.replace(/\s/g, ''))
} else {
  console.log('SKIP  declares the same injected services as the official bundle'
    + ` — could not resolve the inject list from ${ourInject === undefined ? 'ours' : 'the official'}`
    + ' bundle (it is a variable reference whose binding was not found as an array literal), so'
    + ' there is nothing to compare; `publishes inject` above is the assertion that holds')
}

const leaked = [...(ours.match(MACHINE_PATH_PATTERN) ?? [])]
check('no build-machine path leaked', leaked.length === 0,
  leaked.length === 0 ? '0 matches' : `${String(leaked.length)} matches: ${JSON.stringify([...new Set(leaked)])}`)
check('stylesheet was inlined, not emitted as a file',
  ours.includes('data-plugin-css'), 'the bundle must inject its own style tag')

console.log('')
console.log(`ours     : ${(ours.length / 1024).toFixed(1)} kB`)
console.log(`official : ${(official.length / 1024).toFixed(1)} kB`)
console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
