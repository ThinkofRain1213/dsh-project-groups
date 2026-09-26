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

const STORE_MODULE = '@deepseek-ai/dsh-client-store'

/** Minimal `createSnapshotStore`: get/set/subscribe over one value. */
const STORE_SOURCE = `
export function createSnapshotStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    set(next) { value = next; for (const fn of [...listeners]) fn() },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
}

/**
 * Minimal store handle. The vendored browser's viewing store needs a handle
 * whose create() yields an instance exposing the state, the draft-bound action
 * table, and the observer face (getSnapshot / subscribe). Nothing under test
 * here reads or writes localStorage; assertions are about which keys the action
 * table keeps, so the draft has to be the live state object rather than a copy.
 */
export function defineStore(spec) {
  const create = () => {
    const state = spec.init()
    const listeners = new Set()
    const notify = () => { for (const fn of [...listeners]) fn() }
    const actions = {}
    for (const [name, fn] of Object.entries(spec.actions ?? {})) {
      actions[name] = (...args) => { fn(state, ...args); notify() }
    }
    return {
      state,
      actions,
      spec,
      getSnapshot: () => state,
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    }
  }
  return { spec: { persist: spec.persist }, create }
}
`

/** Compile one TypeScript source string to ESM JavaScript. */
function transpile(source, fileName) {
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
    },
  }).outputText
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === STORE_MODULE) return { url: `dsh-test:${STORE_MODULE}`, shortCircuit: true }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === `dsh-test:${STORE_MODULE}`) {
    return { format: 'module', shortCircuit: true, source: STORE_SOURCE }
  }
  if (!url.endsWith('.ts') && !url.endsWith('.tsx')) return nextLoad(url, context)
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const source = await readFile(fileURLToPath(url), 'utf8')
  return {
    format: 'module',
    shortCircuit: true,
    source: transpile(source, fileURLToPath(url)),
  }
}
