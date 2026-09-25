/**
 * Verify the built client bundle's `apply()` against a mock DSH client context.
 *
 * This exercises the real artifact (lib/client.js) through its loader wrapper:
 * the bundle is CJS wrapped in `window.__ModuleLoader__.load({ id, factory })`,
 * so we provide that global plus minimal `document`/`react` shims, capture the
 * exports, and call `apply(ctx)` with a recording slot registry.
 *
 * What this proves, without needing a DSH restart:
 *   1. the bundle evaluates and returns the expected public surface;
 *   2. `apply` registers into `sidebar.workspaces` at the shadowing priority;
 *   3. the registration declares the locale namespace and an inject factory;
 *   4. the inject factory yields exactly the navigation callbacks, and calling
 *      them reaches the `uiWorkspace` service by name.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** Minimal document shim: the bundle injects one <style> tag at load. */
const styleTags = []
const documentShim = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => { styleTags.push(tag) } },
}

let loaded
const windowShim = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded = { id, exports: factory((spec) => require(spec)) }
    },
  },
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}

// Type-only imports are erased, so the bundle needs no @deepseek-ai modules.
const sandbox = {
  window: windowShim,
  document: documentShim,
  console,
  globalThis: undefined,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
new vm.Script(fs.readFileSync(join(root, 'lib/client.js'), 'utf8'), { filename: 'client.js' })
  .runInContext(sandbox)

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

check('bundle registered under its package id', loaded?.id === 'dsh-project-groups', loaded?.id)
check('bundle exposes apply + inject', typeof loaded?.exports?.apply === 'function'
  && Array.isArray(loaded?.exports?.inject), `inject=${JSON.stringify(loaded?.exports?.inject)}`)
check('stylesheet was injected once', styleTags.length === 1, `tags=${styleTags.length}`)

// --- mock context -----------------------------------------------------------

const localeNamespaces = []
/** Records what the inject factory produced and how the callbacks behave. */
const navCalls = []
const ownerStub = {
  startSession: (workspaceId) => { navCalls.push(['startSession', workspaceId]) },
  openSession: (sessionId) => { navCalls.push(['openSession', sessionId]) },
}

/**
 * Build a recording client context.
 * @param get - service lookup, mirroring the real `ctx.get(name)`.
 * @returns the context plus the array its registrations land in.
 */
function makeCtx(get) {
  const sink = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    get,
    locale: { register: (ns, dict) => { localeNamespaces.push([ns, dict]); return () => {} } },
    slots: {
      inject: (name, factory) => {
        // The shell calls the factory once the hole is declared.
        factory()
        if (sink.length > 0) sink[sink.length - 1].injectedInto = name
      },
      register: (options, component) => {
        sink.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, sink }
}

const { ctx: ctxWithOwner, sink: recorded } = makeCtx(
  (name) => (name === 'uiWorkspace' ? ownerStub : undefined),
)

loaded.exports.apply(ctxWithOwner)

check('registered exactly one entry', recorded.length === 1, `count=${recorded.length}`)
const reg = recorded[0] ?? {}
check('injected into sidebar.workspaces', reg.injectedInto === 'sidebar.workspaces', reg.injectedInto)
check('registration names the slot', reg.options?.name === 'sidebar.workspaces', reg.options?.name)
check('priority shadows the official entry (lower than 0)',
  typeof reg.options?.priority === 'number' && reg.options.priority < 0,
  `priority=${reg.options?.priority}`)
check('declares its locale namespace', typeof reg.options?.locale === 'string', reg.options?.locale)
check('ships a component', typeof reg.component === 'function', typeof reg.component)
check('locale dictionaries registered', localeNamespaces.length === 1
  && localeNamespaces[0][1]?.zh !== undefined && localeNamespaces[0][1]?.en !== undefined,
  `ns=${localeNamespaces[0]?.[0]}`)

// The inject factory is what the renderer calls; it must yield the two verbs.
const injected = typeof reg.options?.inject === 'function' ? reg.options.inject() : undefined
check('inject yields startSession + open',
  typeof injected?.startSession === 'function' && typeof injected?.open === 'function',
  Object.keys(injected ?? {}).join(','))

injected?.startSession('ws-1')
injected?.open('session-1')
check('startSession reaches the owner service',
  navCalls.some(([m, a]) => m === 'startSession' && a === 'ws-1'), JSON.stringify(navCalls))
check('open reaches the owner service',
  navCalls.some(([m, a]) => m === 'openSession' && a === 'session-1'), JSON.stringify(navCalls))

// A composition without uiWorkspace must degrade, not throw.
let threw = false
try {
  const { ctx: bareCtx, sink: bareSink } = makeCtx(() => undefined)
  loaded.exports.apply(bareCtx)
  const bareInject = bareSink[0].options.inject()
  bareInject.startSession('ws-x')
  bareInject.open('session-x')
} catch (error) {
  threw = true
  console.error(error)
}
check('degrades safely without the owner service', !threw)

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
