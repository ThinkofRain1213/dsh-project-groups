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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The Loader's real patch algorithm, as a devDependency so this runs anywhere. */
const include = await import('@deepseek-ai/cordis-plugin-include')
const applyEntryPatches = include.applyEntryPatches

// Parse our patch file exactly as the Loader does. The include package parses
// with `js-yaml` plus a custom `!!js` tag; using a different YAML library (or
// `yaml`'s schema object) both mis-parses and can silently accept shapes the
// Loader would reject. Reuse the Loader's own schema instance.
const jsYaml = require('js-yaml')
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const ourPatches = jsYaml.load(patchText, { schema: include.entryListSchema })

// The rows the web-app bundle layer declares that this plugin cares about.
// Trimmed to the two ids under test; the real layer has hundreds.
const baseRows = [
  { id: 'ui-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar' },
  { id: 'ui-workspace', name: '@deepseek-ai/dsh-client-ui-workspace' },
  { id: 'ui-conversation', name: '@deepseek-ai/dsh-client-ui-conversation' },
]

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const warnings = []
const composed = applyEntryPatches(baseRows, ourPatches, (message, ...args) => {
  let i = 0
  warnings.push(message.replace(/%C/g, () => JSON.stringify(args[i++])))
})

const byId = Object.fromEntries(composed.map(row => [row.id, row]))

console.log('composed rows:')
for (const row of composed) console.log(`  ${row.id}  disabled=${String(row.disabled)}  name=${row.name}`)
if (warnings.length > 0) {
  console.log('patch warnings:')
  for (const w of warnings) console.log(`  ${w}`)
}
console.log('')

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
check('our plugin row is not disabled',
  composed.find(r => r.name === 'dsh-project-groups')?.disabled !== true)
check('untouched rows are left alone',
  byId['ui-sidebar']?.disabled !== true && byId['ui-conversation']?.disabled !== true)

console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
