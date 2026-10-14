/** Workspace command registration and browser-owned opening requests. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionForkError } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCommand, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UiWorkspace } from './navigation.ts'

/** Transient requests consumed by the existing workspace browser. */
export interface WorkspaceShortcutState {  readonly searchRequest: number
  readonly addRequested: boolean
  readonly directoryBusy: boolean
  readonly renameTarget: { readonly sessionId: SessionId; readonly currentTitle: string; readonly seq: number } | null
  readonly forkError: { readonly reason: 'unavailable' | 'failed'; readonly seq: number } | null
}

interface WorkspaceShortcutControls {
  state: SnapshotStore<WorkspaceShortcutState>
  search: () => void
  add: () => void
  closeAdd: () => void
  directoryBusy: (busy: boolean) => void
  rename: (sessionId: SessionId, currentTitle: string) => void
  closeRename: () => void
  forkFailed: (reason: 'unavailable' | 'failed') => void
  dismissForkError: () => void
}

/**
 * The command ids this tree registers.
 *
 * Declared here so `register` can be typed against them instead of `string`. The parameter
 * was `string` and the value was cast to `ShortcutCommandId` on the way in, which meant the
 * cast asserted membership in a set nothing checked — any typo compiled. Listing them makes
 * a wrong id a compile error.
 */
type OwnShortcutId =
  | 'session.new' | 'session.search' | 'workspace.add'
  | 'session.rename' | 'session.fork' | 'session.archive'

/**
 * Raise the fork-failure notice, mapping the rejection to which wording applies.
 *
 * Shared by both entry points for the command — the keyboard binding here and the sidebar's
 * menu row — because they are two ways to press the same button and only one of them used to
 * report anything: the menu row swallowed every rejection, so a Host refusal such as
 * `session/fork-unavailable` closed the menu and changed nothing, with no notice. One rule
 * keeps the two from drifting apart again.
 * @param error - the rejection from the fork request.
 * @param controls - the browser-owned request source that carries the notice.
 */
export function reportForkFailure(
  error: unknown,
  controls: Pick<WorkspaceShortcutControls, 'forkFailed'>,
): void {
  // Client plugin bundles do not share error-class identity, so the check is on `name` — but a
  // name alone proves nothing about the shape. An error carrying `name === 'SessionForkError'`
  // without an `rpcError` (a re-thrown plain error, or one crossing another bundle boundary)
  // would make a bare dereference throw *inside* the catch handler, masking the real failure
  // and skipping `forkFailed` entirely. Optional chaining treats a missing `rpcError` as the
  // generic failure, which is what it is.
  const rpcCode = error instanceof Error && error.name === 'SessionForkError'
    ? (error as Partial<SessionForkError>).rpcError?.code
    : undefined
  const unavailable = rpcCode === 'session/fork-unavailable'
  controls.forkFailed(unavailable ? 'unavailable' : 'failed')
  if (!unavailable) console.warn('session fork rejected:', error)
}

/**
 * Create the private browser request source shared by commands and controls.
 * @returns observable state and its complete mutation callbacks.
 */
export function createWorkspaceShortcutControls(): WorkspaceShortcutControls {
  const state = createSnapshotStore<WorkspaceShortcutState>({
    searchRequest: 0, addRequested: false, directoryBusy: false, renameTarget: null, forkError: null,
  })
  let forkErrorSeq = 0
  /** Monotonic rename-request id; see {@link SessionRenameTarget.seq}. */
  let renameSeq = 0
  return {
    state,
    search: () => {
      // One snapshot per mutation. Calling `getSnapshot()` twice — once to read
      // `searchRequest` and once to spread — reads two different objects if the store is
      // not strictly synchronous, and the second read can already carry another writer's
      // change, so the increment would be computed from a stale base and then applied over
      // a newer one. Reading once and deriving everything from it makes the mutation a
      // function of one observation.
      const before = state.getSnapshot()
      state.set({ ...before, searchRequest: before.searchRequest + 1 })
    },
    add: () => {
      // Three reads collapsed to one, for the same reason. This was also the worst of the
      // three: the condition and the value spread were separate observations, so a store
      // that answered differently between them could test `directoryBusy` on one snapshot
      // and write based on another.
      const before = state.getSnapshot()
      state.set(before.directoryBusy ? before : { ...before, addRequested: true })
    },
    closeAdd: () => {
      const before = state.getSnapshot()
      state.set({ ...before, addRequested: false })
    },
    directoryBusy: (busy: boolean) => {
      const before = state.getSnapshot()
      state.set({ ...before, directoryBusy: busy })
    },
    rename: (sessionId: SessionId, currentTitle: string) => {
      // A per-request sequence, so the dialog's key changes even when the target does not.
      // See `SessionRenameTarget.seq`: keyed on the Session alone, a second request for the same
      // row reused the form and kept the stale draft.
      renameSeq += 1
      const before = state.getSnapshot()
      state.set({ ...before, renameTarget: { sessionId, currentTitle, seq: renameSeq } })
    },
    closeRename: () => {
      const before = state.getSnapshot()
      state.set({ ...before, renameTarget: null })
    },
    forkFailed: (reason) => {
      forkErrorSeq += 1
      const before = state.getSnapshot()
      state.set({ ...before, forkError: { reason, seq: forkErrorSeq } })
    },
    dismissForkError: () => {
      const before = state.getSnapshot()
      state.set({ ...before, forkError: null })
    },
  }
}

/**
 * Register navigation commands against the existing workspace owner.
 * Rename requires a nonblank main Conversation with no modal obscuring it.
 * @param ctx - plugin context with the shortcut, locale, and model services.
 * @param navigation - session creation and forking from the pointer controls' navigation service.
 * @param controls - browser-owned opening requests.
 * @param archiveSession - shared archive action, including running-work confirmation and notices.
 * @param projectModel - whether the composition supplies a project model, which
 * changes what "add" means (and therefore the command's label).
 */
export function installWorkspaceShortcuts(
  ctx: Context,
  navigation: Pick<UiWorkspace, 'startSession' | 'forkSession'>,
  controls: ReturnType<typeof createWorkspaceShortcutControls>,
  archiveSession: (sessionId: SessionId) => void,
  projectModel: boolean,
): void {
  const t = ctx.locale.bind('workspace')
  const current = () => Object.values(ctx.sessions.list.getSnapshot().byId)
    .find(row => (row.retainedBy.mainView ?? 0) > 0)
  const addReason = (): string | null => {
    if (ctx.slots.entries('sidebar.workspaces.directoryFlow').length === 0) return t('shortcut.noPicker')
    if (controls.state.getSnapshot().directoryBusy) return t('shortcut.directoryBusy')
    return null
  }
  // The ids this tree registers. `ShortcutCommandId` upstream is `Branded<'ShortcutCommandId'>`
  // — a purely nominal type with no constructor — so a string literal cannot be assigned to
  // it directly and a cast is unavoidable at the boundary. Narrowing the parameter to this
  // union is what makes the cast safe: it was previously typed `string`, which accepted any
  // value at all and then *asserted* it was a valid id, so a typo would have compiled and
  // registered a command nobody could invoke. Registering an id outside this list is now a
  // compile error at the call site instead of a silent no-op.
  const register = (id: OwnShortcutId, label: () => string, aliases: string[], code: string,
    modifiers: ('primary' | 'alt' | 'shift')[], webModifiers: ('primary' | 'alt' | 'shift')[], resolve: ShortcutCommand['resolve']): void => {
    ctx.effect(() => ctx.shortcuts.register({
      id: id as ShortcutCommandId, label, aliases, defaults: {
        'desktop:macos': { code, modifiers }, 'desktop:windows': { code, modifiers }, 'desktop:linux': { code, modifiers },
        // `web:linux` alongside the other two: the desktop entries cover three platforms,
        // and the web defaults covered only macOS and Windows, so a browser on Linux fell
        // through to no binding at all and the command was unreachable there.
        // (`ShortcutProfile` is `` `${ShortcutRuntime}:${ShortcutPlatform}` ``, and
        // `ShortcutPlatform` includes `'linux'`.)
        'web:macos': { code, modifiers: webModifiers },
        'web:windows': { code, modifiers: webModifiers },
        'web:linux': { code, modifiers: webModifiers },
      },
      regions: ['page', 'editable'], modals: [], resolve,
    }), `ui-workspace: ${id}`)
  }
  register('session.new', () => t('session.new'), ['new session', 'new chat'], 'KeyN', ['primary'], ['primary', 'alt'],
    () => ({ status: 'handled', run: () => { navigation.startSession() } }))
  register('session.search', () => t('search.sessions.aria'), ['search sessions'], 'KeyK', ['primary'], ['primary', 'alt'],
    () => ({ status: 'handled', run: controls.search }))
  // Under a project model the same command opens the project dialog; the
  // directory-flow availability check no longer applies (there is no picker to
  // be missing) and the label names what will happen.
  register('workspace.add',
    () => t(projectModel ? 'project.add' : 'workspace.add'),
    projectModel ? ['new project'] : ['add workspace', 'open folder'],
    'KeyO', ['primary'], ['primary', 'alt'],
    () => {
      if (projectModel) return { status: 'handled', run: controls.add }
      const reason = addReason()
      return reason === null ? { status: 'handled', run: controls.add } : { status: 'blocked', reason }
    })
  register('session.rename', () => t('rename.session.title'), ['rename session'], 'KeyG', ['primary', 'alt'], ['primary', 'alt'], (context) => {
    const target = current()
    return target === undefined || target.blank || context.modal !== null || ctx.layout.panelInfo.getSnapshot().activePanelId !== null
      ? { status: 'blocked', reason: t('shortcut.noSession') }
      : { status: 'handled', run: () => { controls.rename(target.id, target.title?.trim() ?? '') } }
  })
  register('session.fork', () => t('menu.fork'), ['fork session'], 'KeyF', ['primary', 'alt'], ['primary', 'shift'], () => {
    const target = current()
    if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
    if (target.blank) return { status: 'blocked', reason: t('shortcut.noCompletedTurn') }
    return { status: 'handled', run: () => {
      void navigation.forkSession(target.id).catch((error: unknown) => {
        reportForkFailure(error, controls)
      })
    } }
  })
  register('session.archive', () => t('menu.archiveSession'), ['archive session'], 'KeyA', ['primary', 'shift'], ['primary', 'alt'], (context) => {
    const target = current()
    if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
    // The same obscuring gate `session.rename` applies. The review asked whether the
    // asymmetry was intentional; it does not appear to be. Both commands act on the
    // session `current()` derives from `retainedBy.mainView`, and both end up opening a
    // dialog over the list (`rename` sets `renameTarget`; `archiveSession` sets
    // `archiveRequest` for the running-work confirmation), so neither can be said to work
    // "without needing to see the row". Rename refused in this situation and archive did
    // not, which let the same keystroke reach a destructive action that its non-destructive
    // analogue declined to take.
    //
    // `blank` is deliberately **not** checked here, unlike rename: the original archive
    // path had no such check and the review did not raise one, so only the guards it asked
    // about were added. Changing that too would be a second behaviour decision beyond what
    // was reported.
    if (context.modal !== null || ctx.layout.panelInfo.getSnapshot().activePanelId !== null) {
      return { status: 'blocked', reason: t('shortcut.noSession') }
    }
    return { status: 'handled', run: () => {
      archiveSession(target.id)
    } }
  })
}
