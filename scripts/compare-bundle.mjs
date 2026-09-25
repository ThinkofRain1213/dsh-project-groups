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

const ours = fs.readFileSync(join(root, 'lib/client.js'), 'utf8')

let official
const explicit = process.argv[2]
if (explicit !== undefined) {
  official = fs.readFileSync(explicit, 'utf8')
  console.log(`official source: ${explicit}`)
} else {
  const asar = findInstalledAsar()
  if (asar === undefined) {
    console.error('no installed DSH found; pass the official client.js path as an argument')
    process.exit(2)
  }
  official = readAsarFile(asar, OFFICIAL_ENTRY)
  console.log(`official source: ${asar}${OFFICIAL_ENTRY}`)
}
console.log('')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const externalsOf = src => [...new Set([...src.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]))].sort()
const idOf = src => src.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)?.[1]

const ourExternals = externalsOf(ours)
const officialExternals = externalsOf(official)

check('registers under this plugin\'s own id', idOf(ours) === OUR_ID, String(idOf(ours)))
check('official registers under its own id (sanity check)',
  idOf(official) === OFFICIAL_ID, String(idOf(official)))
check('resolves the SAME externals as the official bundle',
  JSON.stringify(ourExternals) === JSON.stringify(officialExternals),
  `ours=${JSON.stringify(ourExternals)} official=${JSON.stringify(officialExternals)}`)
check('publishes apply', /exports\.apply\s*=/.test(ours))
check('publishes inject', /exports\.inject\s*=/.test(ours))
check('declares the same injected services as the official bundle',
  /exports\.inject\s*=\s*\[([^\]]*)\]/.exec(ours)?.[1].replace(/\s/g, '')
    === /exports\.inject\s*=\s*\[([^\]]*)\]/.exec(official)?.[1].replace(/\s/g, ''),
  /exports\.inject\s*=\s*\[([^\]]*)\]/.exec(ours)?.[1])
check('no build-machine path leaked', !/C:\\Users/.test(ours),
  `${(ours.match(/C:\\Users/g) ?? []).length} matches`)
check('stylesheet was inlined, not emitted as a file',
  ours.includes('data-plugin-css'), 'the bundle must inject its own style tag')

console.log('')
console.log(`ours     : ${(ours.length / 1024).toFixed(1)} kB`)
console.log(`official : ${(official.length / 1024).toFixed(1)} kB`)
console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
