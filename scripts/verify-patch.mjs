/**
 * Does this plugin's `cordis.patch.yml` actually disable the official workspace
 * browser, and mount ours in its place?
 *
 * This runs the Loader's real patch algorithm
 * (`applyEntryPatches` from `@deepseek-ai/cordis-plugin-include`) over the rows
 * the web profile composes, so the answer is not a reading of the docs.
 *
 * The order matters and is asserted here: bundle → profile → home → CLI layers
 * apply in that order. The official `ui-workspace` row is declared by the
 * web-app bundle layer, and this plugin's patch is a later layer, so the
 * disable lands on a row that already exists. A patch naming an unknown id is
 * skipped with a warning rather than failing loudly, which is exactly the trap
 * this script exists to catch.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { format as formatMessage } from 'node:util'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * The Loader's real patch algorithm, as a devDependency so this runs anywhere.
 *
 * Loaded inside a guard, and both exports are asserted. This used to be a bare top-level
 * `await import` plus `include.applyEntryPatches` — so a missing devDependency, a resolution
 * error, or a renamed export left `applyEntryPatches` as `undefined` and the script died with a
 * stack trace (or a cryptic "applyEntryPatches is not a function") instead of saying what was
 * wrong. `entryListSchema` matters just as much: it is what makes `js-yaml` parse with the
 * Loader's own `!!js` tag, and an undefined schema would silently fall back to the default one
 * and accept shapes the Loader rejects — a green run that proves nothing.
 */
let include
try {
  include = await import('@deepseek-ai/cordis-plugin-include')
} catch (error) {
  check('可以载入 @deepseek-ai/cordis-plugin-include', false,
    String(error?.message ?? error).slice(0, 160))
  console.log('')
  console.log('1 CHECK(S) FAILED')
  process.exit(1)
}
const applyEntryPatches = include.applyEntryPatches
const entryListSchema = include.entryListSchema
check('加载器导出了 applyEntryPatches', typeof applyEntryPatches === 'function')
check('加载器导出了 entryListSchema', entryListSchema !== undefined)
if (failures.length > 0) {
  console.log('')
  console.log(`${failures.length} CHECK(S) FAILED`)
  process.exit(1)
}

// Parse our patch file exactly as the Loader does. The include package parses
// with `js-yaml` plus a custom `!!js` tag; using a different YAML library (or
// `yaml`'s schema object) both mis-parses and can silently accept shapes the
// Loader would reject. Reuse the Loader's own schema instance.
const jsYaml = require('js-yaml')
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const ourPatches = jsYaml.load(patchText, { schema: entryListSchema })

/**
 * The rows the bundle layer declares that this plugin cares about, by id.
 *
 * Three rows, not two — the comment here used to say the fixture was "trimmed to the two ids
 * under test" while three were declared, which is how the real problem stayed invisible: this
 * stub is the only stand-in for the bundle layer, so **every id `cordis.patch.yml` targets has
 * to be in it**. One that is not makes `applyEntryPatches` skip that patch and warn, and the
 * checks below then fail with a message about a row that is perfectly fine in production.
 *
 * The patch targets are derived from the patch file and checked against this map, so a new
 * target is a clear failure here rather than a confusing one three checks later.
 * `ui-sidebar` and `ui-conversation` are included as the "untouched rows" controls.
 */
const KNOWN_ROWS = {
  'ui-sidebar': '@deepseek-ai/dsh-client-ui-sidebar',
  'ui-workspace': '@deepseek-ai/dsh-client-ui-workspace',
  'ui-conversation': '@deepseek-ai/dsh-client-ui-conversation',
}

/** Every id the patch file must match for it to apply rather than be skipped. */
const patchTargetIds = [...new Set(
  ourPatches.flatMap(patch => (patch?.id ? [patch.id] : [])),
)]

check('桩覆盖了 patch 命中的每个 id',
  patchTargetIds.every(id => id in KNOWN_ROWS),
  JSON.stringify(patchTargetIds.filter(id => !(id in KNOWN_ROWS))))

const baseRows = Object.entries(KNOWN_ROWS).map(([id, name]) => ({ id, name }))

const warnings = []
const composed = applyEntryPatches(baseRows, ourPatches, (message, ...args) => {
  // `util.format`, not a hand-rolled `%C` replacement.
  //
  // The sink is documented as printf-style, and `%C` is this loader's own specifier for a code.
  // Substituting only `%C` meant a message using `%s`/`%d`/`%o` — or `%%` — printed its raw
  // specifier with the arguments dropped, hiding the cause of exactly the failure this script
  // exists to surface. `%C` is rewritten to `%s` first so the platform formatter handles the
  // rest; the value is a string id, so `%s` is the right conversion.
  warnings.push(formatMessage(message.replace(/%C/g, '%s'), ...args))
})

const byId = Object.fromEntries(composed.map(row => [row.id, row]))

console.log('composed rows:')
for (const row of composed) console.log(`  ${row.id}  disabled=${String(row.disabled)}  name=${row.name}`)
if (warnings.length > 0) {
  console.log('patch warnings:')
  for (const w of warnings) console.log(`  ${w}`)
}
console.log('')

// `warnings.length === 0` is exactly "no patch was skipped" for this loader version — checked
// rather than assumed. All five `warn(...)` call sites in `applyEntryPatches`
// (`patch insert: entry %C not found`, `… is not a group`, `patch: id is required for
// non-insert patches`, `patch: entry %C not found`, `patch: name mismatch for %C (…) skipping`)
// are immediately followed by `continue`, so the sink is used for skips and nothing else.
check('no patch was skipped (every id matched a row)',
  warnings.length === 0, warnings.join(' | ') || 'none')
check('official ui-workspace row is disabled',
  byId['ui-workspace']?.disabled === true, String(byId['ui-workspace']?.disabled))
check('official row keeps its name (disable, not replace)',
  byId['ui-workspace']?.name === '@deepseek-ai/dsh-client-ui-workspace',
  String(byId['ui-workspace']?.name))
check('our plugin row is mounted',
  composed.some(row => row.name === 'dsh-project-groups'),
  composed.filter(r => r.name === 'dsh-project-groups').map(r => r.id).join(',') || 'missing')
// Requires the row to **exist**, then that it is not disabled.
//
// `?.disabled !== true` was vacuously true when the row was absent: `find` returns `undefined`,
// `?.disabled` yields `undefined`, and `undefined !== true` is `true` — so it reported PASS for a
// row that is not there, the opposite of what the check above asserts.
//
// Not `=== false`: an inserted row carries no `disabled` field at all (measured — the composed
// row is `{ id: 'project-groups', name: 'dsh-project-groups' }`), and in cordis an absent
// `disabled` means enabled. Demanding an explicit `false` would fail on a correct patch.
const pluginRow = composed.find(r => r.name === 'dsh-project-groups')
check('our plugin row is not disabled',
  pluginRow !== undefined && pluginRow.disabled !== true,
  pluginRow === undefined ? 'row missing' : String(pluginRow.disabled))
check('untouched rows are left alone',
  byId['ui-sidebar']?.disabled !== true && byId['ui-conversation']?.disabled !== true)

console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
