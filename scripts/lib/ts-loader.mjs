/**
 * Node module hooks that transpile the vendored TypeScript before evaluation.
 *
 * `tree.ts` happens to be strip-only-safe, so a plain `import` works there. The
 * rest of the vendored tree is not: `navigation.ts` uses constructor parameter
 * properties, which Node's `--experimental-strip-types` rejects outright. Rather
 * than reshape vendored source for the test runner's benefit (the tree is meant
 * to stay re-syncable), this transpiles with the project's own TypeScript.
 *
 * Register it from a test's first line:
 *   import { register } from 'node:module'
 *   register('./lib/ts-loader.mjs', import.meta.url)
 *
 * It also answers `@deepseek-ai/dsh-client-store` with a minimal snapshot store.
 * That package is a shell platform module (our bundle never reaches it), and its
 * published form pulls `zustand`, which is not installed here because nothing in
 * this repo needs it at runtime. Tests exercise the vendored *logic*, so the
 * store only has to behave like one.
 */
import ts from 'typescript'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const STORE_MODULE = '@deepseek-ai/dsh-client-store'

/** Minimal `createSnapshotStore`: get/set/subscribe over one value. */
const STORE_SOURCE = `
export function createSnapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    // Notifies only on a real change, like the real store does (it compares with
    // \`Object.is\`). Notifying unconditionally would wake every subscriber for a write that
    // changed nothing, which is invisible in a passing test and is exactly the kind of
    // extra render a subscriber-counting assertion would be measuring.
    set(next) { if (Object.is(value, next)) return; value = next; for (const fn of [...listeners]) fn() },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
}

/**
 * Minimal store handle. The vendored browser's viewing store needs a handle
 * whose create() yields an instance exposing the state, the draft-bound action
 * table, and the observer face (getSnapshot / subscribe). Nothing under test
 * here reads or writes localStorage; assertions are about which keys the action
 * table keeps, so the draft has to be the live state object rather than a copy.
 *
 * \`spec\` is the declared spec itself, not a narrowed \`{ persist }\` copy. The real handle
 * exposes \`StoreSpec\` — \`init\`, \`persist\`, \`actions\` — and handing back only the one field
 * meant a caller reading \`handle.spec.init\` or \`.actions\` would get \`undefined\` with no
 * error. Nothing under test reads them *today*, which is exactly why the narrowing survived;
 * exposing the object costs nothing and removes the trap.
 *
 * The baked actions return what the declared mutator returned. They used to drop it, so a
 * mutator written as \`() => Boolean\` — the shape several of the vendored ones have — answered
 * \`undefined\` to every caller through the handle while answering correctly through a direct
 * call.
 */
export function defineStore(spec) {
  const create = () => {
    const state = spec.init()
    const listeners = new Set()
    const notify = () => { for (const fn of [...listeners]) fn() }
    const actions = {}
    for (const [name, fn] of Object.entries(spec.actions ?? {})) {
      actions[name] = (...args) => { const result = fn(state, ...args); notify(); return result }
    }
    return {
      state,
      actions,
      spec,
      getSnapshot: () => state,
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    }
  }
  return { spec, create }
}
`

/**
 * Compile one TypeScript source string to ESM JavaScript.
 *
 * Syntax is checked with `createSourceFile(...).parseDiagnostics`, **not** with
 * `transpileModule`'s own `diagnostics`. Measured: for `export const broken = = 1`,
 * `transpileModule` reports **zero** diagnostics and emits `export const broken =  = 1;` —
 * invalid JavaScript that then fails in Node's parser with `Unexpected token '='`, pointing at
 * the loader rather than at the vendored file. `parseDiagnostics` reports `Expression
 * expected.` for the same input, reports nothing for a well-formed file, and reports nothing
 * for JSX in a `.tsx` — so it can be checked unconditionally.
 *
 * The diagnostics were discarded entirely before this, which is what let a broken vendored
 * file reach the test as a confusing downstream error.
 * @param source - the file text.
 * @param fileName - its path, for diagnostics.
 * @returns the transpiled module source.
 * @throws {Error} when the file does not parse.
 */
function transpile(source, fileName) {
  const parsed = ts.createSourceFile(
    fileName, source, ts.ScriptTarget.ES2022, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  if (parsed.parseDiagnostics.length > 0) {
    const report = ts.formatDiagnostics(parsed.parseDiagnostics, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    })
    throw new Error(`ts-loader: ${fileName} does not parse\n${report}`)
  }
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      // Isolated: no type information, so this is per-file and order-free.
      isolatedModules: true,
      // Keep imports as written: the loader resolves them, and `import type`
      // must still vanish.
      verbatimModuleSyntax: false,
      // Needed for `.tsx`, which this hook claims below. Without it JSX is passed through
      // untransformed and the module fails to parse when Node evaluates it — the hook
      // advertised `.tsx` support it did not have.
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText
}

/** Whether a specifier is the stubbed package or one of its subpaths. */
function isStoreSpecifier(specifier) {
  return specifier === STORE_MODULE || specifier.startsWith(`${STORE_MODULE}/`)
}

export async function resolve(specifier, context, nextResolve) {
  // The package and its subpaths both: matching the bare specifier alone meant an import of
  // `@deepseek-ai/dsh-client-store/something` fell through to real resolution, which pulls the
  // published form — and that is the form that needs `zustand`. Nothing imports a subpath
  // today, so this was latent rather than broken.
  if (isStoreSpecifier(specifier)) return { url: `dsh-test:${specifier}`, shortCircuit: true }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('dsh-test:')) {
    return { format: 'module', shortCircuit: true, source: STORE_SOURCE }
  }
  if (!url.endsWith('.ts') && !url.endsWith('.tsx')) return nextLoad(url, context)
  // One conversion, used for both the read and the diagnostics. It was computed twice for the
  // same URL.
  const filePath = fileURLToPath(url)
  let source
  try {
    source = await readFile(filePath, 'utf8')
  } catch (error) {
    // Named, rather than the raw ENOENT from `readFile`. A loader failure is reported by Node
    // against whichever module triggered it, so an unannotated filesystem error here reads as
    // a mystery in an unrelated test file.
    throw new Error(`ts-loader: cannot read ${filePath} — ${error.code ?? String(error)}`)
  }
  return {
    format: 'module',
    shortCircuit: true,
    source: transpile(source, filePath),
  }
}
