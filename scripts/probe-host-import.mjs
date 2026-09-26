/**
 * The Host half must be importable by the runtime that loads it.
 *
 * This exists because `pnpm build` succeeding proves nothing about whether DSH
 * can load the artifact. A decorator emitted verbatim into `lib/index.js` builds
 * cleanly, passes typecheck, and then fails inside the boot with only
 * `project-groups (dsh-project-groups): failed to import` — no cause, because the
 * loader reports the symptom rather than the error.
 *
 * Importing the artifact here surfaces the real message, and also proves every
 * bare specifier resolves from the installation's runtime.
 *
 * Usage: node scripts/probe-host-import.mjs lib/index.js
 */
import { pathToFileURL } from 'node:url'

const artifact = process.argv[2]
if (artifact === undefined) {
  console.error('usage: node probe-host-import.mjs <path-to-lib/index.js>')
  process.exit(2)
}

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// Every bare specifier the artifact imports, resolved on its own. The harness
// packages are supplied by the installation through the profile's hoisted
// linker, so a resolution failure here is a real boot failure.
const specifiers = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-storage-domain',
  'zod',
]
for (const specifier of specifiers) {
  try {
    const resolved = import.meta.resolve(specifier, pathToFileURL(artifact).href)
    check(`resolves ${specifier}`, resolved !== '', resolved.split('/node_modules/').at(-1) ?? resolved)
  } catch (error) {
    check(`resolves ${specifier}`, false, error.code ?? String(error))
  }
}

try {
  await import(pathToFileURL(artifact).href)
  check('the artifact imports', true)
} catch (error) {
  check('the artifact imports', false, `${error.code ?? ''} ${String(error.message).split('\n')[0]}`)
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
