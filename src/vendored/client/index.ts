/**
 * Workspace plugin, browser half. Two registrations: WorkspaceBrowser fills
 * the sidebar shell's `sidebar.workspaces` hole (the whole browsing region),
 * and WorkspacePicker fills the conversation hero's picker hole
 * (`conversation.hero.workspace` — both hero forms). Both read real Host
 * Workspaces through the global useWorkspaces hook, and each declares its
 * own `single` directory-flow child hole for the composed picker package's
 * client half. WorkspaceBrowser additionally declares the two Session row
 * action lists, and this apply registers the shipped actions — pin, rename,
 * fork, archive — into them the way any client plugin would, each with its
 * own behavior, plus the rename dialog and the row-action notice into
 * `shell.overlay` (see the contract module doc). It also declares two
 * Session-row seats: the leading decoration a row renders only while its own
 * primary state is idle, and the section the row's hover card renders between
 * its relative time and its trailing status line. Export discipline:
 * packages/client/AGENTS.md.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, SessionActivity, WorkspaceArchiveError, WorkspaceSnapshot,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the Controller service merges.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the Session root standard-hook merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  type ArchiveSessionInjected, type BaseWorkspaceDialogInjected, type BaseWorkspaceMissingRequest,
  type BaseWorkspaceRoute,
  type ForkSessionInjected, menuOpenStateFactory, type PinSessionInjected,
  type SessionArchiveConfirmInjected, type SessionArchiveConfirmRequest,
  type RenameSessionInjected, type RowToast, type RowToastInjected, type RowToastState, type SessionRenameDialogInjected,
  type WorkspaceBrowserInjected, type WorkspacePickerInjected,
} from './contract/slots.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from './shortcuts.ts'
import { UiWorkspaceService } from './navigation.ts'
import { createWorkspaceViewStore } from './stores.ts'
import type { GroupSource } from './tree.ts'
import { WorkspaceBrowser } from './rows/WorkspaceBrowser.tsx'
import { ArchiveSessionMenuItem, ArchiveSessionRowButton, SessionArchiveConfirmDialog } from './session-actions/ArchiveSession.tsx'
import { BaseWorkspaceMissingDialog } from './session-actions/BaseWorkspaceMissing.tsx'
import { derive } from './session-actions/derived.ts'
import { ForkSessionMenuItem } from './session-actions/ForkSession.tsx'
import { PinSessionMenuItem, PinSessionRowButton } from './session-actions/PinSession.tsx'
import { RenameSessionMenuItem, SessionRenameDialog } from './session-actions/RenameSession.tsx'
import { RowActionToast } from './session-actions/RowActionToast.tsx'
import { WorkspacePicker } from './WorkspacePicker.tsx'
import { en, zh, type WorkspaceKey } from './locales.ts'

export type { UiWorkspace } from './navigation.ts'
export type { GroupSource } from './tree.ts'
export type {
  BaseWorkspaceRoute,
  DirectoryFlowOwnerProps, DirectoryFlowSlotName, DirectoryPickingHooks, DirectoryPickingInjected,
  MenuOpenState, RowToast, SessionRenameTarget, SessionRowOwnerProps, UseMenuOpenState, WorkspaceBrowserInjected,
  SessionRowScheduleOwnerProps,
  WorkspaceBrowserProps,
  WorkspacePickerInjected, WorkspacePickerProps,
} from './contract/slots.ts'
export type { WorkspaceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Selector hook over the pure Workspace Controller snapshot. */
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>
  }

  interface LocaleNamespaceMap {
    /** The workspace browsing region and pick/create flow copy. */
    workspace: WorkspaceKey
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    workspaceOperation: unknown
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'workspace'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * the ui-sidebar / ui-conversation applies, whose activation order relative
 * to this one is NOT constrained: dsh.client.inject edges are informational
 * (loading/prefetch metadata, never apply sequencing) and neither owner
 * provides a waitable service. apply therefore depends on each slot
 * declaration through `slots.inject()` instead of assuming order.
 */
export const inject = [
  'slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.directoryPicker', 'layout', 'shortcuts',
]

/** No caller-owned group has been touched: the default `expansions` snapshot. */
const EMPTY_EXPANSIONS: Readonly<Record<string, boolean>> = Object.freeze({})

/** No caller-owned group has a recorded order: the default `orders` snapshot. */
const EMPTY_ORDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({})

/**
 * The caller's project verbs, threaded into the browsing region's inject face.
 * Absent, the region keeps the shipped directory flow and a caller-supplied
 * group renders with no row menu or drag target.
 */
export interface ProjectActions {
  createProject: (input: { title: string }) => Promise<void>
  renameProject: (id: string, title: string) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  reorderProject: (id: string, beforeId?: string) => Promise<void>
  /** File one Session under one project; a project row's ＋ uses this. */
  assignSession: (sessionId: SessionId, projectId: string) => Promise<void>
  /** Return one Session to Ungrouped; a drop on the Ungrouped bucket uses this. */
  unassignSession: (sessionId: SessionId) => Promise<void>
  /** Record one project row's open/closed state in the caller's own store. */
  setProjectExpanded: (projectId: string, expanded: boolean) => Promise<void>
  /** Replace the manual order of every caller-supplied project at once. */
  setProjectOrders: (orders: Readonly<Record<string, readonly string[]>>) => Promise<void>
  /**
   * Place a Session that an **unscoped** New Session opened.
   *
   * A row's own ＋ states a destination and never reaches this; it governs the
   * entries that state none — the sidebar shell's New Session button and its
   * shortcut, and any plugin starting a Session without a target. The caller
   * decides where it goes; this browser only supplies what it alone can see.
   *
   * Absent, an unscoped New Session is left where the navigation put it, which is
   * the shipped behaviour.
   */
  placeUnscopedSession?: ((input: UnscopedPlacement) => void) | undefined
  /**
   * Derive the official default Workspace's directory, for the missing-基层工作区
   * dialog's copy.
   *
   * The region cannot do this itself: the path begins at the OS Documents folder,
   * which only the Host can query, so the caller relays it over its own Remote.
   * Absent, the dialog reports the path as unknown.
   * @param request - the report waiting on the path.
   * @returns the path, or null when it cannot be derived.
   */
  defaultWorkspacePath?: ((request: BaseWorkspaceMissingRequest) => Promise<string | null>) | undefined
  /**
   * Create the missing 底层工作区 again (directory + registration).
   *
   * Absent until that capability lands; the dialog then renders the button disabled.
   * @returns a promise that resolves once the Workspace exists again.
   */
  rebuildBaseWorkspace?: (() => Promise<void>) | undefined
  /**
   * Open the picker that re-points the 底层工作区 at an existing Workspace.
   *
   * Absent until the settings chooser lands; the dialog then renders the button
   * disabled.
   */
  chooseBaseWorkspace?: (() => void) | undefined
  /**
   * Where the 底层工作区 setting points, for the entries that state no destination.
   *
   * Those are the shell's New Session button and its shortcut, ui-schedule,
   * ui-agent-preset, and a caller-supplied group's own ＋ (a project row and the
   * Ungrouped bucket both carry no `workspaceId` — see `tree.ts`).
   *
   * Absent, they resolve the official default exactly as the shipped plugin does, which
   * is what keeps an unmodified composition unaffected.
   */
  resolveBaseWorkspace?: (() => BaseWorkspaceRoute) | undefined
}

/**
 * What the browser knows about an unscoped New Session that the caller does not.
 *
 * `updatedAt` is here because the region already holds the Session list; the
 * caller owns the project model but has no view of Session activity, and "the
 * most recently used project" needs exactly that.
 */
export interface UnscopedPlacement {
  /** The Session that was just created. */
  readonly sessionId: SessionId
  /** The Session the user was looking at, when there is one. */
  readonly currentSessionId: SessionId | undefined
  /**
   * Session id → last activity, **blank Sessions excluded**, for the "most recent
   * project" policy. A blank row carries a creation time rather than activity, so
   * it is not evidence of anything; see the assembly above.
   */
  readonly updatedAt: Readonly<Record<string, number>>
}

/**
 * Register the browser and picker once their slot declarations are on the
 * ledger. Inject factories return plain callbacks; data reads use the
 * framework's global hooks.
 * @param ctx - client root context.
 * @param groupingOverride - optional grouping model. Omitted — how the loader
 * calls this on an unmodified composition — the region groups by the Host
 * Workspace registry exactly as upstream. Supplied, the region renders those
 * groups instead, while Sessions keep their real Workspace account, `cwd`, and
 * archive state; see `contract/slots.ts` `grouping` and `tree.ts`
 * `GroupSource`.
 * @param projectActions - optional verbs behind the region's project rows.
 * Omitted, the header keeps the directory flow and caller-supplied groups have
 * no row actions.
 * @param expansionsOverride - optional record of caller-supplied groups'
 * expansion, keyed by group key. Omitted, every group's expansion lives in this
 * browser's own view store, exactly as upstream. Supplied, the caller owns that
 * state and this browser only reads and reports it — which is what lets a
 * caller keep it somewhere the official plugin's mount cannot prune.
 * @param ordersOverride - optional record of caller-supplied groups' manual
 * member order, keyed by group key. Omitted, every group's order lives in this
 * browser's own view store, exactly as upstream. Supplied, the caller owns it,
 * for the same reason as `expansionsOverride`.
 */
export function apply(
  ctx: Context,
  groupingOverride?: HostObservable<readonly GroupSource[] | undefined>,
  projectActions?: ProjectActions,
  expansionsOverride?: HostObservable<Readonly<Record<string, boolean>>>,
  ordersOverride?: HostObservable<Readonly<Record<string, readonly string[]>>>,
): void {
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  // One viewing-store instance, created here as ui-layout does for its layout
  // store: the browser declares the handle, and the UiWorkspace service writes
  // view order through the same instance the renderer hands the browser.
  const viewHandle = createWorkspaceViewStore()
  const viewInstance = viewHandle.create()
  const viewStore: typeof viewHandle = { ...viewHandle, create: () => viewInstance }
  const rowToast = createSnapshotStore<RowToastState | null>(null)
  let toastSeq = 0
  const notify = (toast: RowToast): void => { rowToast.set({ ...toast, seq: ++toastSeq }) }
  // The unscoped-placement callback. `updatedAt` is assembled here because this
  // is the only half holding the Session list; the caller owns the project model
  // and has no view of Session activity.
  //
  // Blank Sessions are left out. A blank row is the unstarted New Session, and
  // `reuseOrCreateBlank` reuses one — so the Session being placed right now is
  // itself blank, already in this map, carrying its own creation time. Counting
  // it would let the Session decide its own destination, and would hand whatever
  // project it was last filed under a fresh timestamp it did no work for. A blank
  // parked in a project is no evidence of work in that project either, so the
  // exclusion is by the row's own `blank` flag rather than by id.
  const placeUnscoped = projectActions?.placeUnscopedSession === undefined
    ? undefined
    : (sessionId: SessionId, currentSessionId: SessionId | undefined): void => {
      const byId = sessions.list.getSnapshot().byId
      const activity: Record<string, number> = {}
      for (const [id, summary] of Object.entries(byId)) {
        if (summary !== undefined && !summary.blank) activity[id] = summary.updatedAt
      }
      projectActions.placeUnscopedSession?.({
        sessionId,
        currentSessionId,
        updatedAt: activity,
      })
    }
  const uiWorkspace = new UiWorkspaceService(
    ctx, ctx.remote.directoryPicker, workspaces, sessions, viewInstance.actions, notify, placeUnscoped,
    // The report is raised synchronously by the failing click, so the path — which
    // needs a Host round trip — is filled in afterwards. The dialog is already open
    // by then and shows "path unknown" for that one beat, which is better than
    // delaying the whole dialog behind a process spawn.
    request => {
      baseWorkspaceRequest.set(request)
      if (request.path !== null) return
      projectActions?.defaultWorkspacePath?.(request).then(path => {
        // Only annotate the report still on screen: a second click (or a dismissal)
        // replaces it, and this answer belongs to the first.
        if (baseWorkspaceRequest.getSnapshot() !== request) return
        baseWorkspaceRequest.set({ ...request, path })
      }).catch(() => {
        // A failed derivation leaves the dialog saying "path unknown", which is
        // exactly what it already shows.
      })
    },
    // The last constructor argument: where the caller's 底层工作区 setting points.
    // Absent, every unscoped New Session resolves the official default as before.
    projectActions?.resolveBaseWorkspace,
  )
  ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workspace: dictionaries')
  const shortcutControls = createWorkspaceShortcutControls()

  const searchSessions: WorkspaceBrowserInjected['searchSessions'] = async (query, signal) => {
    const result = await sessions.search(query, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  // Stable per-surface occupancy sources (the renderer's hook cache keys by
  // source identity): true while the surface's directory-flow hole is filled.
  const flowSource = (hole: 'sidebar.workspaces.directoryFlow' | 'conversation.hero.workspace.directoryFlow'): HostObservable<boolean> => ({
    getSnapshot: () => ctx.slots.entries(hole).length > 0,
    subscribe: listener => ctx.slots.subscribe(hole, listener),
  })
  const browserFlowSource = flowSource('sidebar.workspaces.directoryFlow')
  // Grouping model override. Omitted (the one-argument call the loader makes on
  // an unmodified composition) leaves `undefined` as the active state, so the
  // region groups by the Host Workspace registry exactly as upstream. The
  // observable is mandatory and the value inside it is what varies because the
  // renderer binds hooks from the observable's identity.
  const grouping: HostObservable<readonly GroupSource[] | undefined> = groupingOverride ?? {
    getSnapshot: () => undefined,
    subscribe: () => () => {},
  }
  // Same shape as `grouping`: the hook is mandatory and its identity is what the
  // renderer binds, so a composition that does not own expansion state supplies
  // an observable that answers an empty record. With no verb alongside it, every
  // key resolves to this browser's own view store — upstream behaviour.
  const expansions: HostObservable<Readonly<Record<string, boolean>>> = expansionsOverride ?? {
    getSnapshot: () => EMPTY_EXPANSIONS,
    subscribe: () => () => {},
  }
  // Same shape again: with no caller-owned order and no verb beside it, every key
  // resolves to this browser's own view store — upstream behaviour.
  const orders: HostObservable<Readonly<Record<string, readonly string[]>>> = ordersOverride ?? {
    getSnapshot: () => EMPTY_ORDERS,
    subscribe: () => () => {},
  }
  const hostInfo: HostObservable<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }
  const pickerFlowSource = flowSource('conversation.hero.workspace.directoryFlow')
  const openSession: WorkspaceBrowserInjected['open'] = (sessionId) => {
    uiWorkspace.openSession(sessionId)
  }
  // Registry-global sets as Sets, rebuilt only when the Workspace snapshot changes.
  const pinnedSet = derive(workspaces.list, snapshot => new Set<SessionId>(snapshot.pinnedSessionIds))
  const archivedSet = derive(workspaces.list, snapshot => new Set<SessionId>(snapshot.archivedSessionIds))
  // Plugin-private facts the row actions and their overlay surfaces share:
  // the pending rename request and the notice on display. Each business
  // writes through its own injected callback and the surface reads through
  // its bound hook.
  const renameRequest = derive(shortcutControls.state, state => state.renameTarget)
  const archiveRequest = createSnapshotStore<SessionArchiveConfirmRequest | null>(null)
  // The missing-基层工作区 report. Its own store rather than a toast: the toast is a
  // passing notice, while this needs three decisions and must stay until one is made.
  const baseWorkspaceRequest = createSnapshotStore<BaseWorkspaceMissingRequest | null>(null)
  const requestSessionRename = shortcutControls.rename
  const unarchiveSession = (sessionId: SessionId): void => {
    uiWorkspace.unarchiveSession(sessionId).catch((reason: unknown) => {
      console.warn('session unarchive rejected:', reason)
    })
  }
  const renameSession: SessionRenameDialogInjected['renameSession'] = async (sessionId, title) => {
    const result = await sessions.using(
      sessionId,
      { source: 'workspaceOperation' },
      reference => reference.binding.session.rename(title),
    )
    if (!result.ok) throw new Error(result.error.message)
  }
  const pinInjected = (): PinSessionInjected => ({
    hooks: { pinned: pinnedSet, archived: archivedSet },
    // Pin failures surface as a notice: nothing else on the surface moves, so
    // a silent failure would read as a dead action.
    pinSession: (sessionId) => {
      uiWorkspace.pinSession(sessionId).catch(() => { notify({ kind: 'pinFailed' }) })
    },
    unpinSession: (sessionId) => {
      uiWorkspace.unpinSession(sessionId).catch(() => { notify({ kind: 'unpinFailed' }) })
    },
  })
  const archiveInjected = (): ArchiveSessionInjected => ({
    hooks: { archived: archivedSet },
    // Archive preserves the log and the account position, so a quiet Session
    // needs no confirmation; the notice offers undo and the archived filter.
    // The Host's refusal for running work is the one case that asks first:
    // the confirmation names that work and offers to stop it.
    archiveSession: (sessionId) => {
      uiWorkspace.archiveSession(sessionId).then(() => {
        notify({ kind: 'archived', sessionId })
      }).catch((reason: unknown) => {
        const activity = activeSessionRefusal(reason)
        if (activity === undefined) {
          console.warn('session archive rejected:', reason)
          return
        }
        const displayTitle = sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId
        archiveRequest.set({ sessionId, displayTitle, activity })
      })
    },
    unarchiveSession,
  })
  installWorkspaceShortcuts(ctx, uiWorkspace, shortcutControls, archiveInjected().archiveSession, projectActions !== undefined)
  const archiveConfirmInjected = (): SessionArchiveConfirmInjected => ({
    hooks: { archiveRequest },
    settleSessionArchive: () => { archiveRequest.set(null) },
    stopAndArchiveSession: async (sessionId) => {
      await uiWorkspace.archiveSession(sessionId, { stopActivity: true })
      notify({ kind: 'stoppedAndArchived', sessionId })
    },
  })
  // The two repairs arrive with their own steps: `rebuildBaseWorkspace` once the Host
  // can create the directory, `chooseBaseWorkspace` once the settings picker exists.
  // Until then the dialog renders their buttons disabled, which is why the caller
  // supplies them rather than this region inventing an action.
  const baseWorkspaceInjected = (): BaseWorkspaceDialogInjected => ({
    hooks: { baseWorkspaceRequest },
    settleBaseWorkspaceMissing: () => { baseWorkspaceRequest.set(null) },
    rebuildBaseWorkspace: projectActions?.rebuildBaseWorkspace,
    chooseBaseWorkspace: projectActions?.chooseBaseWorkspace,
  })
  const forkInjected = (): ForkSessionInjected => ({
    forkSession: (sessionId) => {
      uiWorkspace.forkSession(sessionId).catch(() => {
        // Fork or child-title failure leaves the list as it was.
      })
    },
  })
  const renameInjected = (): RenameSessionInjected => ({ requestSessionRename })
  const renameDialogInjected = (): SessionRenameDialogInjected => ({
    hooks: { renameRequest },
    settleSessionRename: shortcutControls.closeRename,
    renameSession,
  })
  const rowToastInjected = (): RowToastInjected => ({
    hooks: { toast: rowToast },
    dismissToast: () => { rowToast.set(null) },
    undoArchive: unarchiveSession,
    showArchived: () => { viewInstance.actions.setArchivedFilter('show') },
  })
  const browserInjected = (): WorkspaceBrowserInjected => ({
    // Explicit group actions keep their target; an unscoped New Session goes wherever the
    // caller's base-workspace setting points, falling back to the official default.
    startSession: (workspaceId, beforeOpen) => { uiWorkspace.startSession(workspaceId, beforeOpen) },
    open: openSession,
    searchSessions,
    searchResultLimit: sessions.searchResultLimit,
    requestSessionRename,
    notifyArchivedNotOpenable: () => { notify({ kind: 'archivedNotOpenable' }) },
    renameWorkspace: async (workspaceId, title) => { await workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      await workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    unarchiveSession: async (sessionId) => { await uiWorkspace.unarchiveSession(sessionId) },
    createWorkspace: input => workspaces.create(input),
    requestSearch: shortcutControls.search,
    requestAddWorkspace: shortcutControls.add,
    closeAddWorkspace: shortcutControls.closeAdd,
    setDirectoryBusy: shortcutControls.directoryBusy,
    dismissForkError: shortcutControls.dismissForkError,
    // Project verbs exist only when the composition supplies a model. Spread
    // rather than assigned as `undefined` so the injected face carries no keys
    // at all without one — the region then reads them as absent and keeps the
    // shipped directory flow.
    ...(projectActions === undefined ? {} : {
      createProject: projectActions.createProject,
      renameProject: projectActions.renameProject,
      deleteProject: projectActions.deleteProject,
      reorderProject: projectActions.reorderProject,
      assignSession: projectActions.assignSession,
      unassignSession: projectActions.unassignSession,
      setProjectExpanded: projectActions.setProjectExpanded,
      setProjectOrders: projectActions.setProjectOrders,
    }),
    hooks: {
      directoryFlow: browserFlowSource,
      hostInfo,
      workspaceShortcuts: shortcutControls.state,
      shortcuts: ctx.shortcuts.catalog,
      grouping,
      expansions,
      orders,
    },
  })
  const pickerInjected = (): WorkspacePickerInjected => ({
    createWorkspace: input => workspaces.create(input),
    hooks: { directoryFlow: pickerFlowSource },
  })
  // Each registration declares its owned children in the same call; slot
  // injection follows both the owner and declaration HMR lifetimes.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      children: {
        'sidebar.workspaces.directoryFlow': { kind: 'single', scope: 'root' },
        // Every row entry reads the menu's open state through a hook bound
        // from the row's render occurrence (the owner passes the state pair
        // as hookContext).
        'sidebar.workspaces.session.menu.item': {
          kind: 'list', scope: 'root', inject: { hooks: { menuOpenState: menuOpenStateFactory, shortcuts: ctx.shortcuts.catalog } },
        },
        'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' },
        'sidebar.session.row.leading': { kind: 'list', scope: 'root' },
        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
      },
      store: viewStore,
      inject: browserInjected,
      locale: NS,
    },
    WorkspaceBrowser,
  ))
  // The shipped row actions take the same route as a plugin's: `slots.inject`
  // waits for the browser registration above to declare each list, and the
  // entries leave with it. Orders step by 100 so a plugin entry can land
  // between them.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'pin', order: 100, locale: NS, inject: pinInjected }, PinSessionMenuItem)
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'rename', order: 200, locale: NS, inject: renameInjected }, RenameSessionMenuItem)
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'fork', order: 300, locale: NS, inject: forkInjected }, ForkSessionMenuItem)
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'archive', order: 400, locale: NS, inject: archiveInjected }, ArchiveSessionMenuItem)
  })
  ctx.slots.inject('sidebar.workspaces.session.row.action', function* () {
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'archive', order: 100, locale: NS, inject: archiveInjected }, ArchiveSessionRowButton)
    yield ctx.slots.register({ name: 'sidebar.workspaces.session.row.action', id: 'pin', order: 200, locale: NS, inject: pinInjected }, PinSessionRowButton)
  })
  // The surfaces the actions raise live in the frame-wide layer: they must
  // outlive the row menu the action sat in.
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.session-rename', locale: NS, inject: renameDialogInjected,
    }, SessionRenameDialog)
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.session-archive', locale: NS, inject: archiveConfirmInjected,
    }, SessionArchiveConfirmDialog)
    // The missing-base-workspace dialog: a click that could not land must say so, and
    // offer the two repairs. It stands alone rather than reusing the toast because it
    // asks a question instead of reporting one.
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.base-missing', locale: NS, inject: baseWorkspaceInjected,
    }, BaseWorkspaceMissingDialog)
    // The toast shares the browser's viewing store: it reads the archived
    // filter to drop the archived notice's filter action once rows are visible.
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'workspace.row-toast', locale: NS, store: viewStore, inject: rowToastInjected,
    }, RowActionToast)
  })
  ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register(
    {
      name: 'conversation.hero.workspace',
      children: { 'conversation.hero.workspace.directoryFlow': { kind: 'single', scope: 'root' } },
      inject: pickerInjected,
      locale: NS,
    },
    WorkspacePicker,
  ))
}

/**
 * The activity a Host `workspace/session-active` refusal reported, or nothing
 * for any other failure. The class identity check goes by name: client plugin
 * bundles do not share error-class identity.
 */
function activeSessionRefusal(reason: unknown): readonly SessionActivity[] | undefined {
  if (!(reason instanceof Error) || reason.name !== 'WorkspaceArchiveError') return undefined
  const { rpcError } = reason as WorkspaceArchiveError
  return rpcError.code === 'workspace/session-active' ? rpcError.details.activity : undefined
}
