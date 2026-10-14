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
 * bare specifier it names resolves from the installation's runtime.
 *
 * The specifier list is **read out of the artifact** rather than maintained by hand: a new
 * dependency added to the Host used to leave this probe green while the new specifier was
 * never validated at all, which defeated the stated purpose. Only the packages the loader
 * hands the plugin (which the artifact therefore never imports) are listed here.
 *
 * Usage: node scripts/probe-host-import.mjs lib/index.js
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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

/**
 * Packages the loader supplies as arguments rather than the artifact importing them.
 *
 * `@deepseek-ai/cordis` arrives as the `ctx` argument, so it appears nowhere in the
 * artifact's import list — but the boot fails just the same when the installation cannot
 * resolve it, which is what this probe is about.
 */
const LOADER_PROVIDED = ['@deepseek-ai/cordis']

/**
 * Every bare specifier a source file names.
 *
 * Covers `import ... from`, `export ... from`, side-effect `import "x"`, dynamic
 * `import("x")` and `require("x")` (a bundle may be emitted as CJS). Relative paths and
 * `node:`/`data:`/`file:` builtins are skipped: they are not the installation's business.
 * A subpath specifier (`@scope/pkg/sub`) is kept whole, since that is what must resolve.
 *
 * Comments are stripped first. Without that the scan matched ordinary prose in the
 * artifact's own JSDoc — a sentence containing the word `from "..."` reported a package
 * that does not exist, and the probe failed for a reason unrelated to any import.
 *
 * Regex rather than a parser: the file under test is generated output, and a format this
 * misses is caught by the emptiness assertion below rather than silently ignored.
 * @param source - the artifact's text.
 * @returns the sorted, deduplicated bare specifiers.
 */
const bareSpecifiersOf = (source) => {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // The `[^:]` guard keeps `https://` inside a string literal from counting as a comment.
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const found = new Set()
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1]
      const isRelativeOrBuiltin = specifier.startsWith('.') || specifier.startsWith('/') ||
        /^(?:node|data|file):/.test(specifier)
      if (!isRelativeOrBuiltin) found.add(specifier)
    }
  }
  return [...found].sort()
}

let source
try {
  source = readFileSync(artifact, 'utf8')
} catch (error) {
  check(`可以读取产物 ${artifact}`, false, String(error?.message ?? error))
}
const specifiers = source === undefined
  ? []
  : [...new Set([...bareSpecifiersOf(source), ...LOADER_PROVIDED])].sort()
// A resolution probe over an empty list would report ALL CHECKS PASSED while checking
// nothing, so the extraction is itself asserted: an unrecognised bundle format shows up
// here instead of as a silently green run.
check('从产物中解析出裸模块清单', specifiers.length > 0, specifiers.join(', '))
if (specifiers.length > 0) console.log(`  产物里的裸模块: ${specifiers.join(', ')}`)

// `createRequire`, not `import.meta.resolve(specifier, parent)`: the two-argument form is
// only honoured under `--experimental-import-meta-resolve`, and without the flag Node
// **ignores** the parent and resolves from the script's own location — so the "resolves
// from the artifact's installation" claim this probe makes was not what was measured.
// (Note the resolution conditions differ: `require` rather than `import`. The import check
// below is the authority for the artifact actually loading.)
const require = createRequire(pathToFileURL(artifact))
for (const specifier of specifiers) {
  let resolved
  let resolutionError
  try {
    resolved = require.resolve(specifier)
  } catch (error) {
    resolutionError = error
  }
  check(`resolves ${specifier}`, resolved !== undefined,
    resolved === undefined
      ? String(resolutionError?.code ?? resolutionError?.message ?? resolutionError)
      : resolved.split(/[\\/]node_modules[\\/]/).at(-1) ?? resolved)
}

let importError
try {
  await import(pathToFileURL(artifact).href)
} catch (error) {
  importError = error
}
// `error?.stack` rather than `error.message`: a module (or a dependency) may throw a
// non-Error value, and dereferencing `.message` on it would replace the real failure with
// an unrelated TypeError — hiding exactly the diagnostic this script exists to surface.
check('the artifact imports', importError === undefined,
  importError === undefined
    ? undefined
    : `${importError?.code ?? ''} ${String(importError?.stack ?? importError).split('\n')[0]}`)

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exitCode = failures.length === 0 ? 0 : 1
