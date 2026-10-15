/**
 * Assert that the committed `lib/` matches what `src/` builds.
 *
 * `lib/` is what `files` ships, so a source change committed without its regenerated artifact
 * would publish a bundle that does not correspond to the source beside it. This runs *after* a
 * build, so a dirty `lib/` here means exactly that drift.
 *
 * ## Why this is a script rather than an inline step
 *
 * It used to be a `run: |` block in `validate.yml` written in bash (`set -euo pipefail`,
 * `CHANGED="$(…)"`, `if [ -n "$CHANGED" ]`). That workflow runs a matrix that **includes
 * Windows**, and GitHub Actions uses `pwsh` as the default shell there — so PowerShell tried to
 * parse `if [ -n "$CHANGED" ]; then` and died with a `ParserError` before running anything. Both
 * Windows legs failed on every run, and the failure looked like a bundle-drift report while
 * actually being a shell mismatch: the one signal this step exists to produce was unavailable on
 * a third of the matrix.
 *
 * A Node script has no such dependency. It also matches every other step in that workflow, which
 * already calls `pnpm run <script>`.
 *
 * ## Porcelain, not `git diff --exit-code`
 *
 * `git diff` compares only **tracked** files, so a build that emitted a brand-new artifact under
 * `lib/` — or deleted one — would have reported clean. `--porcelain` covers modified, added and
 * deleted at once.
 *
 * ## The failure is in the exit code, not the message
 *
 * `git status --porcelain` always exits 0, so the previous form had to test the output rather than
 * chain the command. That is also why this script checks the text and sets its own exit code.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run `git status --porcelain` over one path.
 * @param path - repository-relative path to inspect.
 * @returns the raw porcelain output, split into non-empty lines.
 */
const porcelain = (path) => {
  const out = execFileSync('git', ['status', '--porcelain', '--', path], {
    cwd: root,
    encoding: 'utf8',
  })
  return out.split('\n').map(line => line.trimEnd()).filter(line => line !== '')
}

try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' })
} catch (error) {
  console.error(`FAIL  cannot inspect the working tree: ${String(error?.message ?? error)}`)
  process.exit(2)
}

const changed = porcelain('lib/')

if (changed.length === 0) {
  console.log('PASS  the committed bundles match what `src/` builds')
  process.exit(0)
}

console.log('FAIL  the committed bundles are NOT in sync with src/')
for (const line of changed) console.log(`        ${line}`)
console.log('')
console.log('      `lib/` is what `files` ships, so publishing now would ship a bundle that does')
console.log('      not correspond to the source beside it. Run `pnpm build` and commit the result.')
process.exit(1)
