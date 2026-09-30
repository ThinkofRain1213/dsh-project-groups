/**
 * Behaviour test for the New Session entry points.
 *
 * Three surfaces reach session creation and this round changed where an
 * unscoped one lands:
 *
 *   - the sidebar shell's button and its keyboard shortcut  -> startSession()
 *   - ui-schedule / ui-agent-preset                          -> startSession()
 *   - the Ungrouped bucket and our own groups                -> startSession(group.workspaceId)
 *   - a real Workspace row's own button                      -> startSession(workspaceId)
 *
 * The shipped code guessed the target for the unscoped case (the current
 * Session's Workspace, then the most recently used one) and did nothing at all
 * for a group without a Workspace id. Now the unscoped case resolves the Host's
 * default Workspace, and the no-default case does nothing — deliberately, per
 * the agreed option B.
 *
 * This drives the real `UiWorkspaceService` (the class the vendored apply
 * constructs and the sidebar shell resolves through `ctx.get('uiWorkspace')`),
 * not a copy of its logic. The vendored half is transpiled rather than
 * strip-loaded because `navigation.ts` uses constructor parameter properties,
 * which Node's `--experimental-strip-types` rejects; see `scripts/lib/ts-loader.mjs`.
 */
import { register } from 'node:module'

register('./lib/ts-loader.mjs', import.meta.url)

globalThis.window = { __ModuleLoader__: { load: () => {} } }

const { UiWorkspaceService } = await import('../src/vendored/client/navigation.ts')
const { Context } = await import('@deepseek-ai/cordis')
const { createSnapshotStore } = await import('@deepseek-ai/dsh-client-store')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const wid = value => value
const sid = value => value

/** One Workspace row. */
const workspace = (workspaceId, sessionIds = []) => ({
  workspaceId, path: `C:/ws/${workspaceId}`, title: workspaceId, sessionIds,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

const session = (id, extra = {}) => ({
  // `title` is the durable title `sessionTitle` reads since 0.2.0; `displayTitle` is its
  // human-facing fallback. Upstream set both in its own specs when it added the field.
  id, title: id, displayTitle: id, blank: false, origin: 'user', updatedAt: 1000, retainedBy: {}, ...extra,
})

const snapshot = (items, extra = {}) => ({
  items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null, ...extra,
})

const listState = (byId, ids = Object.keys(byId)) => ({
  phase: 'ready', ids, byId, projectionsBySession: {}, searchResultLimit: 20,
})

/**
 * Minimal stand-ins for the two controllers plus the layout service.
 * `recording` collects the calls the assertions read.
 */
function bench({ items = [], sessions = {}, initializeDefault } = {}) {
  const recording = { connect: [], created: [], notify: [], selectPanel: [] }
  const ctx = new Context()
  const layout = {
    beginNavigation: () => new AbortController().signal,
    selectPanel: id => { recording.selectPanel.push(id) },
  }
  ctx.provide('layout', layout)

  const workspacesSnapshot = snapshot(items)
  const sessionsState = listState(sessions)
  const workspaces = {
    list: { getSnapshot: () => workspacesSnapshot, subscribe: () => () => {} },
    initializeDefault: initializeDefault ?? (async () => undefined),
    archiveSession: async () => {}, unarchiveSession: async () => {}, pinSession: async () => {}, unpinSession: async () => {},
  }
  const sessionsController = {
    list: { getSnapshot: () => sessionsState, subscribe: () => () => {} },
    retain: target => ({
      sessionId: typeof target === 'string' ? target : target.sessionId,
      release: () => {},
    }),
    // `replaceMain` resolves the retained target through this before opening.
    subagentAddress: id => id,
    create: async opts => {
      // Record both the request and the id handed back, so an assertion can check
      // that the id the caller saw is the one creation produced.
      const created = sid(opts.sessionId ?? `new-${recording.created.length + 1}`)
      recording.created.push({ ...opts, sessionId: created })
      return created
    },
    fork: async () => sid('fork'),
    using: async () => ({ ok: true, value: undefined }),
    search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
  }
  const directoryPicker = { pick: async () => ({ ok: true, value: null }), list: async () => ({ ok: true, value: {} }), createDirectory: async () => ({ ok: true, value: '' }) }
  const view = { pinSessionOrder: () => {} }
  const notify = toast => { recording.notify.push(toast) }

  const uiWorkspace = new UiWorkspaceService(
    ctx, directoryPicker, workspaces, sessionsController, view, notify,
  )
  // `connectWorkspace` resolves the row itself; record it by wrapping.
  const originalConnect = uiWorkspace.connectWorkspace.bind(uiWorkspace)
  uiWorkspace.connectWorkspace = async (workspaceId) => {
    recording.connect.push(workspaceId)
    return originalConnect(workspaceId)
  }
  // The constructor also starts the SHIPPED startup restore (`watchNavigation`
  // -> `reconcile` -> `restoreSelection`), which may itself resolve the default
  // Workspace or create a blank Session. That is upstream behaviour and not
  // under test; `settle()` lets it finish, then clears the recording so each
  // assertion sees only the click under test.
  const settle = async () => {
    await tick()
    recording.connect.length = 0
    recording.created.length = 0
    recording.notify.length = 0
    recording.selectPanel.length = 0
  }
  return { uiWorkspace, workspaces, recording, layout, settle }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

// 1. Unscoped with a default Workspace -> resolves it and creates there.
{
  const b = bench({
    items: [workspace('default', []), workspace('other', [])],
    initializeDefault: async () => workspace('default', []),
  })
  await b.settle()
  b.uiWorkspace.startSession()
  await tick()
  check('unscoped startSession resolves the default Workspace',
    b.recording.connect.join(',') === 'default', b.recording.connect.join(',') || '(none)')
  check('unscoped startSession creates the Session in that Workspace',
    b.recording.created.length === 1 && b.recording.created[0].workspaceId === 'default',
    JSON.stringify(b.recording.created))
}

// 2. Unscoped ignores the current Session's Workspace (the shipped guess).
{
  const b = bench({
    items: [workspace('default', []), workspace('current-ws', ['current'])],
    sessions: { current: session('current') },
    initializeDefault: async () => workspace('default', []),
  })
  // A current Session in `current-ws` is exactly what the old code preferred.
  await b.settle()
  b.uiWorkspace.startSession()
  await tick()
  check('unscoped startSession does NOT prefer the current Session Workspace',
    b.recording.connect.join(',') === 'default', b.recording.connect.join(',') || '(none)')
}

// 3. Unscoped ignores the most-recently-used Workspace (the other shipped guess).
{
  const b = bench({
    items: [workspace('default', []), workspace('recent', ['recent-session'])],
    sessions: { 'recent-session': session('recent-session', { updatedAt: 9_999_999 }) },
    initializeDefault: async () => workspace('default', []),
  })
  await b.settle()
  b.uiWorkspace.startSession()
  await tick()
  check('unscoped startSession does NOT prefer the most recent Workspace',
    b.recording.connect.join(',') === 'default', b.recording.connect.join(',') || '(none)')
}

// 4. Explicit Workspace id -> targets itself, never consults the default.
{
  let askedForDefault = 0
  const b = bench({
    items: [workspace('default', []), workspace('explicit', [])],
    initializeDefault: async () => { askedForDefault += 1; return workspace('default', []) },
  })
  await b.settle()
  b.uiWorkspace.startSession(wid('explicit'))
  await tick()
  check('explicit startSession targets that Workspace',
    b.recording.connect.join(',') === 'explicit', b.recording.connect.join(',') || '(none)')
  check('explicit startSession never resolves the default', askedForDefault === 0, `asked ${askedForDefault}x`)
}

// 5. Option B: no default Workspace -> nothing happens, selection survives.
{
  const b = bench({
    items: [],
    initializeDefault: async () => undefined,
  })
  await b.settle()
  b.uiWorkspace.startSession()
  await tick()
  check('no default: no Workspace is opened', b.recording.connect.length === 0,
    b.recording.connect.join(',') || '(none)')
  check('no default: no Session is created', b.recording.created.length === 0)
  check('no default: the current selection is NOT cleared (the shipped guess did)',
    b.recording.selectPanel.length === 0, JSON.stringify(b.recording.selectPanel))
}

// 6. A refused lookup surfaces one notice and still does nothing.
{
  const b = bench({
    items: [],
    initializeDefault: async () => { throw new Error('lookup unavailable') },
  })
  await b.settle()
  b.uiWorkspace.startSession()
  await tick()
  check('a failed default lookup reports a notice',
    b.recording.notify.length === 1 && b.recording.notify[0].kind === 'defaultWorkspaceFailed',
    JSON.stringify(b.recording.notify))
  check('a failed default lookup opens nothing', b.recording.connect.length === 0)
}

// 7. The resolved id is not cached: a second click resolves again, so a replaced
//    registration cannot leave a stale id behind.
{
  let resolutions = 0
  const b = bench({
    items: [workspace('default', [])],
    initializeDefault: async () => { resolutions += 1; return workspace('default', []) },
  })
  await b.settle()
  b.uiWorkspace.startSession()
  await tick()
  await b.settle()
  b.uiWorkspace.startSession()
  await tick()
  check('each click resolves the default again (no stale cache)', resolutions === 2, `resolved ${resolutions}x`)
}

// 8. The optional `beforeOpen` callback hands the caller the Session that
//    landed, which is how a project row files what it just created. Omitted, the
//    flow must behave exactly as before.
{
  const b = bench({
    items: [workspace('default', [])],
    initializeDefault: async () => workspace('default', []),
  })
  await b.settle()
  const seen = []
  b.uiWorkspace.startSession(undefined, (sessionId) => { seen.push(sessionId) })
  await tick()
  check('beforeOpen receives the created Session id', seen.length === 1, JSON.stringify(seen))
  check('and it is exactly the id creation returned',
    seen[0] === b.recording.created[0]?.sessionId,
    JSON.stringify({ seen, created: b.recording.created }))
}

// 9. An explicit Workspace id also reports its Session.
{
  const b = bench({
    items: [workspace('explicit', [])],
    initializeDefault: async () => workspace('default', []),
  })
  await b.settle()
  const seen = []
  b.uiWorkspace.startSession(wid('explicit'), (sessionId) => { seen.push(sessionId) })
  await tick()
  check('an explicit target reports its Session too', seen.length === 1, JSON.stringify(seen))
}

// 10. No callback is the old contract: the flow still runs and nothing is
//     required of the caller.
{
  const b = bench({
    items: [workspace('default', [])],
    initializeDefault: async () => workspace('default', []),
  })
  await b.settle()
  b.uiWorkspace.startSession()
  await tick()
  check('omitting beforeOpen still creates the Session',
    b.recording.created.length === 1, JSON.stringify(b.recording.created))
}

// 11. A flow that resolves no Workspace never reports a Session.
{
  const b = bench({ items: [], initializeDefault: async () => undefined })
  await b.settle()
  const seen = []
  b.uiWorkspace.startSession(undefined, (sessionId) => { seen.push(sessionId) })
  await tick()
  check('no default Workspace means no callback', seen.length === 0, JSON.stringify(seen))
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
