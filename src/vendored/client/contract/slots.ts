/**
 * ui-workspace contracts. Two registrations share this package:
 *
 * - WorkspaceBrowser fills the sidebar shell's `sidebar.workspaces` hole —
 *   the whole browsing region (section header, search, grouped/flat session
 *   list, workspace dialogs). It registers this package's viewing store and
 *   consumes the shell's two-fact owner share (wide / expandSidebar).
 * - WorkspacePicker fills the conversation empty-state hole (menu + error
 *   dialog shared with the browser).
 *
 * Both registrations declare a **directory-flow hole** (`single` kind): the
 * slot a composed picker package's client half fills with its
 * picking interaction — a renderless native-chooser driver or an in-app
 * browsing dialog. ui-workspace owns the trigger (the "Add workspace…"
 * entry, present only while the hole is occupied) and the adoption
 * semantics (`createWorkspace({ path })`, the retryable error dialog,
 * Choose again); the occupant owns everything between `open` and the picked path,
 * including creating a new directory to hand back. That occupant-owned
 * creation is why adding a workspace has a single route: an unoccupied hole
 * leaves the surface with no add affordance at all.
 * Two holes exist because the two menu surfaces are independent slot entries
 * and a hole has exactly one declaring entry — they carry the same owner
 * contract and the same occupant.
 *
 * WorkspaceBrowser also declares the two **Session row action lists**: every
 * row of a Session's "..." menu is an entry of
 * `sidebar.workspaces.session.menu.item`, and every hover button at the row's
 * end is an entry of `sidebar.workspaces.session.row.action`. The shipped
 * actions — pin, rename, fork, archive — are ordinary entries this package
 * registers from `apply`, each carrying its own behavior in its own inject
 * face and reading its own Host state through hooks that face injects, so a
 * client plugin's action lands beside them by `order` and needs nothing from
 * the browser beyond the row identity.
 *
 * The browser entry additionally declares two `list` seats per Session row
 * (`sidebar.session.row.leading` / `sidebar.session.row.hover`) for ambient
 * row decorations. Both take the row's Session identity and nothing else: a
 * session-scoped seat would force a Session binding, which would activate and
 * retain every listed Session.
 */
import type {
  HostObservable, InjectFace, PropsHooks, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore, SlotHookFactory,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the owner SlotMap merges into programs that resolve the
// runtime shares below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionActivity, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { WorkspaceShortcutState } from '../shortcuts.ts'
import type { GroupSource } from '../tree.ts'
import type { createWorkspaceViewStore } from '../stores.ts'

/**
 * Owner share of the directory-flow holes: the complete conversation between
 * the trigger surface and the picking interaction. The occupant reads `open`
 * to run/render its interaction and reports exactly one outcome per open.
 */
export interface DirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked path (`createWorkspace` in flight); occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (chooser missing, listing denied); the owner shows its error surface. */
  onError: (message: string) => void
}

/** Owner share of one Session row action occurrence: the row the action belongs to. */
export interface SessionRowOwnerProps {
  /** Session the row shows. */
  sessionId: SessionId
  /** Row display title: persisted title, project basename, or Session id. */
  displayTitle: string
}

/** The row menu's open state as its owner holds it: the `useState` pair. */
export type MenuOpenState = readonly [open: boolean, setOpen: (open: boolean) => void]

/**
 * Hook every row-menu entry receives. Rows only render while the menu is
 * open, so an entry reads it for the setter: `setOpen(false)` dismisses the
 * menu the entry sits in — the same state the owner's `onClose` sets.
 */
export type UseMenuOpenState = () => MenuOpenState

/**
 * Bind the row's render occurrence into the entries' `useMenuOpenState` hook:
 * the owner supplies its open-state pair as the occurrence's `hookContext`,
 * and the hook hands that pair back.
 * @param _standard - framework standard props (unused).
 * @param state - the menu's open-state pair from the render occurrence.
 * @returns the hook the entry calls.
 */
export const menuOpenStateFactory: SlotHookFactory<'sidebar.workspaces.session.menu.item', UseMenuOpenState> =
  (_standard, state) => () => state

/**
 * Owner share of the two Session-row schedule seats. Both receive only the
 * row's Session identity: the occupant reads that Session's own scheduled
 * tasks, and reading them activates nothing.
 */
export interface SessionRowScheduleOwnerProps {
  /** Session this row shows; the occupant addresses its own data by this id. */
  readonly sessionId: SessionId
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Directory-flow hole under the conversation empty-state picker (declared by the WorkspacePicker entry). */
    'conversation.hero.workspace.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    /** Directory-flow hole under the sidebar browsing region (declared by the WorkspaceBrowser entry). */
    'sidebar.workspaces.directoryFlow': { kind: 'single'; scope: 'root'; owner: DirectoryFlowOwnerProps }
    /**
     * Leading decoration of one Session row, in the 16px cell before the title
     * that the row's own state dot otherwise occupies. A higher-priority state
     * (a pending interaction, a new message, live activity) replaces the seat
     * with that dot for the same row, so an occupant here never renders beside
     * a status dot and is mounted only by a row whose primary state is idle.
     * An archived row keeps that cell blank — neither its status dot nor this
     * seat renders there, and its live status appears on the hover card only.
     */
    'sidebar.session.row.leading': { kind: 'list'; scope: 'root'; owner: SessionRowScheduleOwnerProps }
    /**
     * Section of the Session row's hover card between its relative time and
     * its trailing status line. Mounted only while that card is open.
     */
    'sidebar.session.row.hover': { kind: 'list'; scope: 'root'; owner: SessionRowScheduleOwnerProps }
    /**
     * The rows of one Session's "..." menu, in ascending `order`. ui-workspace
     * registers the shipped rows here — `pin` (100), `rename` (200), `fork`
     * (300), `archive` (400) — so a plugin row is placed by its own `order`
     * among them. Use a package-namespaced `id`; reusing a shipped id at
     * another `priority` shadows that row. Each entry renders one
     * `role="menuitem"` `<button>` (the shipped rows use ui-primitives'
     * `MenuItemButton`, which adds the host styling and `separatorBefore`),
     * decides its own visibility from its own state, and dismisses the menu
     * through the injected `useMenuOpenState` hook after acting; the list's
     * keyboard walk and focus return read the DOM, so any such button joins
     * them. Labels come from the contributing package's locale namespace.
     * @example
     * return {
     *   inject: ['slots'],
     *   apply(ctx) {
     *     const copyLabel = 'Copy Session ID' // Localize in the contributing package.
     *     ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
     *       { name: 'sidebar.workspaces.session.menu.item', id: 'copy-session-id', order: 500 },
     *       ({ sessionId, useMenuOpenState }) => {
     *         const [, setMenuOpen] = useMenuOpenState()
     *         return React.createElement(
     *           'button',
     *           { type: 'button', role: 'menuitem', onClick: () => { setMenuOpen(false); void navigator.clipboard.writeText(sessionId) } },
     *           copyLabel,
     *         )
     *       },
     *     ))
     *   },
     * }
     */
    'sidebar.workspaces.session.menu.item': {
      kind: 'list'
      scope: 'root'
      owner: SessionRowOwnerProps
      hookContext: MenuOpenState
      inject: { hooks: {
        menuOpenState: SlotHookFactory<'sidebar.workspaces.session.menu.item', UseMenuOpenState>
        shortcuts: HostObservable<readonly ShortcutCatalogEntry[]>
      } }
    }
    /**
     * The hover buttons at the end of one Session row, in ascending `order`,
     * after the "..." menu trigger. ui-workspace registers `archive` (100) and
     * `pin` (200) here. An entry renders one icon button (or nothing, when its
     * action does not apply to the row) and owns the action it performs. Clicks
     * inside the strip stay in the strip, so the button needs no propagation
     * handling to keep the row from opening.
     */
    'sidebar.workspaces.session.row.action': { kind: 'list'; scope: 'root'; owner: SessionRowOwnerProps }
  }
}

/** The two directory-flow holes; a flow package's client half registers its one component into both. */
export type DirectoryFlowSlotName =
  | 'conversation.hero.workspace.directoryFlow'
  | 'sidebar.workspaces.directoryFlow'

/**
 * Directory-picking share both trigger surfaces consume. Occupancy rides the
 * inject face's reserved `hooks` compartment: the renderer binds the source
 * into the `useDirectoryFlow` selector hook, so an empty hole hides the
 * "Add workspace…" entry reactively and the surface withdraws an open
 * flow whose occupant unloaded mid-interaction (nobody is left to cancel).
 */
export type DirectoryPickingInjected = {
  hooks: {
    /** True while this surface's directory-flow hole is occupied. */
    directoryFlow: HostObservable<boolean>
  }
}

/** Component-side view of the picking share: the bound occupancy selector hook. */
export type DirectoryPickingHooks = PropsHooks<DirectoryPickingInjected['hooks']>

/**
 * Browser-private injected share (arrives via the register inject factory).
 * Data reads use the global framework hooks; these are the Host actions the
 * browsing region drives.
 */
export type WorkspaceBrowserInjected = {
  hooks: DirectoryPickingInjected['hooks'] & {
    /**
     * Fixed Host facts, reached through a hook rather than injected as values:
     * the renderer memoizes an entry's inject result for the registration's
     * lifetime, so facts read there would freeze at whatever the first render
     * saw. Select the field the surface needs (`info => info.home`).
     */
    hostInfo: HostObservable<RemoteHostFacts>
    workspaceShortcuts: HostObservable<WorkspaceShortcutState>
    shortcuts: HostObservable<readonly ShortcutCatalogEntry[]>
    /**
     * Grouping-model override. The snapshot is the caller's group list while
     * the override is active, and `undefined` while it is not — in which case
     * the region groups by the Host Workspace registry exactly as upstream.
     *
     * An empty array is meaningful and distinct from `undefined`: it is an
     * active override that claims no Session, so every visible Session falls
     * into the region's own Ungrouped bucket.
     */
    grouping: HostObservable<readonly GroupSource[] | undefined>
    /**
     * Expansion of caller-supplied groups, keyed by group key.
     *
     * Mandatory as a hook, like `grouping`: the renderer binds hooks from the
     * observable's identity, so a composition without one supplies an observable
     * that answers an empty record. What varies is the value, and whether the
     * companion `setProjectExpanded` verb exists at all.
     *
     * An **absent** key means the group has never been touched, which the region
     * reads as "open the group holding the current Session, once"; a `false`
     * value means the user folded it and nothing may reopen it. Omitted by the
     * caller, every group's expansion lives in this browser's own view store,
     * exactly as upstream — which is why a caller that needs it to survive the
     * official plugin mounting must supply both this and the verb.
     */
    expansions: HostObservable<Readonly<Record<string, boolean>>>
    /**
     * The recorded manual order of each caller-supplied group's members, keyed by
     * group key.
     *
     * Mandatory as a hook for the same reason as `grouping` and `expansions`: the
     * renderer binds hooks from the observable's identity, so a composition
     * without this state supplies an observable answering an empty record.
     *
     * An **absent** key means the group has no manual order, so member position
     * comes from recency. That is not the same as an empty list, and it is why
     * recency mode is expressed by omitting a key rather than by storing one.
     * Omitted by the caller, every group's order lives in this browser's own view
     * store, exactly as upstream.
     */
    orders: HostObservable<Readonly<Record<string, readonly string[]>>>
  }
  /** Open the browser search and focus its input. */
  requestSearch: () => void
  /**
   * The caller's project verbs, present only in a composition that supplies a
   * project model.
   *
   * Every member here is optional as a group: absent, the region behaves exactly
   * as upstream — the header's add control runs the directory flow, and a
   * caller-supplied group renders with no row menu or drag target, because there
   * is nothing behind it to drive.
   */
  createProject?: ((input: { title: string }) => Promise<void>) | undefined
  /** Retitle one caller-supplied project. */
  renameProject?: ((id: string, title: string) => Promise<void>) | undefined
  /** Remove one caller-supplied project; its Sessions are not touched. */
  deleteProject?: ((id: string) => Promise<void>) | undefined
  /** Move one caller-supplied project before another; absent anchor appends. */
  reorderProject?: ((id: string, beforeId?: string) => Promise<void>) | undefined
  /**
   * File one Session under one project, replacing any previous filing.
   *
   * A project row's ＋ calls this for the Session it creates; every other row
   * does not, because Ungrouped means precisely "filed under nothing". Absent,
   * a project row's ＋ still creates a Session — in the default Workspace — but
   * leaves it unfiled, which is the behaviour before project rows existed.
   */
  assignSession?: ((sessionId: SessionId, projectId: string) => Promise<void>) | undefined
  /**
   * Return one Session to Ungrouped.
   *
   * The Ungrouped bucket is the drop target that takes a Session out of a
   * caller-supplied group. Absent, a cross-group drag never activates, so the
   * region behaves exactly as upstream.
   */
  unassignSession?: ((sessionId: SessionId) => Promise<void>) | undefined
  /**
   * Record one caller-supplied project's open/closed state.
   *
   * Supplied together with the `expansions` hook: a composition that owns this
   * state supplies both, so the region never has to guess where to write.
   */
  setProjectExpanded?: ((projectId: string, expanded: boolean) => Promise<void>) | undefined
  /**
   * Replace the manual order of every caller-supplied project at once.
   *
   * Whole-map because the three callers need exactly that: a drop rewrites the
   * target project and freezes the rest, switching to manual freezes all of them,
   * and switching to recency discards them all. A project omitted from the map
   * loses its record.
   *
   * Supplied together with the `orders` hook: a composition that owns this state
   * supplies both, so the region never has to guess where to write.
   */
  setProjectOrders?:
    | ((orders: Readonly<Record<string, readonly string[]>>) => Promise<void>)
    | undefined
  /** Request the existing directory picker. */
  requestAddWorkspace: () => void
  /** Consume the directory-picker opening request. */
  closeAddWorkspace: () => void
  /** Publish directory interaction occupancy for command availability. */
  setDirectoryBusy: (busy: boolean) => void
  /** Dismiss the shortcut's fork-failure notification. */
  dismissForkError: () => void
  /**
   * Start a New Session in a Workspace: reuse-or-create its blank session and
   * open it; without an explicit workspace, resolve the Host's default Workspace.
   * @param beforeOpen - optional synchronous preparation for the Session that
   * lands, run once it exists and before it becomes the main view; see
   * `UiWorkspace.startSession`. A project row uses it to file the Session it
   * just created.
   */
  startSession: (workspaceId?: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void) => void
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /**
   * Search current visible conversation messages. The Host fixes the result
   * bound; `hasMore` means the query needs narrowing.
   */
  searchSessions: (
    query: string,
    signal: AbortSignal,
  ) => Promise<{ items: readonly SessionSearchResultItem[]; hasMore: boolean }>
  /** Maximum number of merged rows rendered for one search. */
  searchResultLimit: number
  /** Open the Session rename dialog (a row title double-click); the rename action entry raises the same request. */
  requestSessionRename: (sessionId: SessionId, currentTitle: string) => void
  /** Tell the user an archived row cannot be opened (a click on it). */
  notifyArchivedNotOpenable: () => void
  /** Rename a Host Workspace (rejects on name conflict; resolves on durability). */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Delete only a Host Workspace registration; directory and Session logs remain. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /**
   * Reorder a Workspace in the durable registry display order.
   * Omitted anchor appends to the end.
   */
  insertWorkspaceBefore: (workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId) => Promise<void>
  /** Remove a Session from the registry-global archived set (the search results' restore button). */
  unarchiveSession: (sessionId: SessionId) => Promise<void>
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
}

/** The browser's declared viewing store handle, shared with the row actions that write view state. */
export type WorkspaceViewStoreHandle = ReturnType<typeof createWorkspaceViewStore>

/** Props of one shipped row-menu entry: owner share + locale seat + the entry's own injected share. */
export type SessionMenuItemProps<Injected extends object = object> =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<'workspace'>
  & InjectFace<Injected>

/** Props of one shipped row hover button: owner share + locale seat + the entry's own injected share. */
export type SessionRowActionProps<Injected extends object = object> =
  PropsRuntime<'sidebar.workspaces.session.row.action'>
  & PropsLocale<'workspace'>
  & InjectFace<Injected>

/** One transient Workspace notice rendered by the overlay toast entry. */
export type RowToast =
  | { kind: 'archived'; sessionId: SessionId }
  | { kind: 'stoppedAndArchived'; sessionId: SessionId }
  | { kind: 'pinFailed' }
  | { kind: 'unpinFailed' }
  | { kind: 'archivedNotOpenable' }
  | { kind: 'defaultWorkspaceFailed' }
  /**
   * An explicit New Session request that failed. `message` is untranslated:
   * a Host refusal as `code: message` — the stable code stays in the copy so
   * a report can be searched by it — and any other failure's own message.
   */
  | { kind: 'createFailed'; message: string }

/** The notice on display; `seq` keys remounts so a repeated notice restarts its hold. */
export type RowToastState = RowToast & { seq: number }

/**
 * Pin action share (menu row and hover button). The callbacks carry the whole
 * behavior: the Host call, fronting the Session in its saved orders after a
 * pin, and the failure notice. The hooks are the registry-global sets as
 * Sets, so a row reads its own membership with one lookup.
 */
export interface PinSessionInjected {
  hooks: {
    /** Pinned Session ids. */
    pinned: HostObservable<ReadonlySet<SessionId>>
    /** Archived Session ids (pin does not apply to an archived row). */
    archived: HostObservable<ReadonlySet<SessionId>>
  }
  /** Pin a Session; on success it leads its accounts' saved orders, on failure the notice says so. */
  pinSession: (sessionId: SessionId) => void
  /** Unpin a Session; saved positions stay as they are. */
  unpinSession: (sessionId: SessionId) => void
}

/**
 * Archive action share (menu row and hover button). The callbacks carry the
 * whole behavior: the Host call, the notice a success raises, the
 * stop-and-archive confirmation a Host refusal for running work raises, and
 * the diagnostics for any other rejection.
 */
export interface ArchiveSessionInjected {
  hooks: {
    /** Archived Session ids. */
    archived: HostObservable<ReadonlySet<SessionId>>
  }
  /**
   * Archive a Session into the registry-global set: the row keeps its
   * account position and shows per the archived filter; archiving the
   * current session clears the selection into the New Session view state.
   * A Session with running work is not archived by this call: the Host's
   * refusal opens the stop-and-archive confirmation instead.
   */
  archiveSession: (sessionId: SessionId) => void
  /** Remove a Session from the registry-global archived set. */
  unarchiveSession: (sessionId: SessionId) => void
}

/**
 * A stop-and-archive confirmation the archive action asked for: the Host
 * refused the plain archive because this work still runs.
 */
export interface SessionArchiveConfirmRequest {
  /** Session to stop and archive. */
  sessionId: SessionId
  /** The row's display title, named in the dialog. */
  displayTitle: string
  /** What the Host reported running, in family order. */
  activity: readonly SessionActivity[]
}

/**
 * Stop-and-archive dialog share: the pending confirmation, its settlement,
 * and the archive hop that asks the Host to stop the work first.
 */
export interface SessionArchiveConfirmInjected {
  hooks: {
    /** The confirmation asked for, until the dialog consumes or cancels it. */
    archiveRequest: HostObservable<SessionArchiveConfirmRequest | null>
  }
  /** Consume or cancel the pending confirmation. */
  settleSessionArchive: () => void
  /**
   * Archive a Session after the Host stops its running work; resolves once
   * the archive set is durable (the stops settle in the background) and
   * raises the stopped-and-archived notice.
   */
  stopAndArchiveSession: (sessionId: SessionId) => Promise<void>
}

/** Fork action share. */
export interface ForkSessionInjected {
  /** Fork a Session at its last completed turn; the child arrives through the Host list. */
  forkSession: (sessionId: SessionId) => void
}

/** Rename action share: the row only raises the request; the dialog entry answers it. */
export interface RenameSessionInjected {
  /** Ask for the rename dialog, seeded with the row's current title. */
  requestSessionRename: (sessionId: SessionId, currentTitle: string) => void
}

/** A Session rename the rename action asked for; the dialog entry opens on it. */
export interface SessionRenameTarget {
  /** Session to rename. */
  sessionId: SessionId
  /** Title the dialog seeds its draft from. */
  currentTitle: string
}

/** Rename dialog share: the pending request, its settlement, and the rename hop the dialog confirms with. */
export interface SessionRenameDialogInjected {
  hooks: {
    /** The rename asked for, until the dialog consumes or cancels it. */
    renameRequest: HostObservable<SessionRenameTarget | null>
  }
  /** Consume or cancel the pending request. */
  settleSessionRename: () => void
  /** Rename a Session (explicit user title; resolves on host acceptance). */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
}

/** Row toast share: the notice on display, its dismissal, and the two actions the archived notice offers. */
export interface RowToastInjected {
  hooks: {
    /** The notice on display, or none. */
    toast: HostObservable<RowToastState | null>
  }
  /** Take the notice down. */
  dismissToast: () => void
  /** Undo an archive from its notice. */
  undoArchive: (sessionId: SessionId) => void
  /** Switch the archived filter to "show" so the archived row is back in view. */
  showArchived: () => void
}

/**
 * One New Session that could not land because its 底层工作区 is gone.
 *
 * The region raises this instead of doing nothing, which is what the shipped flow
 * does: `startSessionInDefaultWorkspace` returns silently when the default Workspace
 * cannot be resolved, so the click had no visible effect at all.
 */
export interface BaseWorkspaceMissingRequest {
  /**
   * Which choice is missing.
   *
   * `'default'` is the official default Workspace, which the region resolves from
   * the registry. `'specified'` is a Workspace the user pinned in the plugin's
   * settings. The two differ in what the dialog may offer, not in how it looks.
   */
  readonly mode: 'default' | 'specified'
  /**
   * The path that is gone, when known.
   *
   * Always known for `'specified'` (the plugin stored it). For `'default'` it is
   * the Host's derivation, which is `null` when the OS Documents folder could not
   * be read — hence optional rather than assumed.
   */
  readonly path: string | null
  /** The stored display name of a `'specified'` Workspace, for the dialog's copy. */
  readonly name: string | null
}

/**
 * Where the 底层工作区 setting points, as the navigation needs it.
 *
 * A discriminated union rather than `workspaceId | undefined`, because the shipped flow has
 * **three** outcomes and an optional id can only express two. In particular "the setting
 * says use the official default" and "the setting names a Workspace that is gone" both end
 * up *not* opening a specific Workspace, yet only the second must report — collapsing them
 * would either silence the report or make the healthy path shout.
 *
 * `'official'` is a member rather than the absence of an answer so that "no callback was
 * supplied" and "the setting says use the official default" stay distinguishable; otherwise
 * a probe could not tell a detached plugin from a default-configured one.
 */
export type BaseWorkspaceRoute =
  /** `'specified'` and still registered: open the New Session in it. */
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  /** `'specified'` but no longer registered: report it, and open nothing. */
  | { readonly kind: 'missing'; readonly path: string | null; readonly name: string | null }
  /** `'default'`, unset, or not yet known: the shipped official-default flow. */
  | { readonly kind: 'official' }

/**
 * Missing-基层工作区 dialog share: the pending report, its dismissal, and the two
 * repairs.
 *
 * Both repairs are **optional**, and that is what lets the dialog ship before the
 * features behind them: with a callback absent, its button renders disabled rather
 * than pretending to act. `rebuildBaseWorkspace` arrives with the Host-side directory
 * creation; `chooseBaseWorkspace` with the settings picker.
 */
export interface BaseWorkspaceDialogInjected {
  hooks: {
    /** The report asked for, until the dialog consumes or cancels it. */
    baseWorkspaceRequest: HostObservable<BaseWorkspaceMissingRequest | null>
  }
  /** Consume or cancel the pending report. */
  settleBaseWorkspaceMissing: () => void
  /** Create the missing Workspace again; absent until the rebuild lands. */
  rebuildBaseWorkspace: (() => Promise<void>) | undefined
  /** Open the Workspace picker; absent until the settings chooser lands. */
  chooseBaseWorkspace: (() => void) | undefined
}

/** Props of the missing-基层工作区 dialog entry in `shell.overlay`. */
export type BaseWorkspaceDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'workspace'>
  & Omit<BaseWorkspaceDialogInjected, 'hooks'>
  & PropsHooks<BaseWorkspaceDialogInjected['hooks']>

/** Props of the rename dialog entry in `shell.overlay`. */
export type SessionRenameDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'workspace'>
  & Omit<SessionRenameDialogInjected, 'hooks'>
  & PropsHooks<SessionRenameDialogInjected['hooks']>

/** Props of the stop-and-archive dialog entry in `shell.overlay`. */
export type SessionArchiveConfirmProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'workspace'>
  & Omit<SessionArchiveConfirmInjected, 'hooks'>
  & PropsHooks<SessionArchiveConfirmInjected['hooks']>

/**
 * Props of the row toast entry in `shell.overlay`. The declared viewing store
 * carries the archived filter; the archived notice omits its filter action
 * when archived rows are already visible.
 */
export type RowToastProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'workspace'>
  & PropsStore<WorkspaceViewStoreHandle>
  & Omit<RowToastInjected, 'hooks'>
  & PropsHooks<RowToastInjected['hooks']>

/** Full browser props: shell owner share + viewing store + injected actions + the locale seat. */
export type WorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsRenderSlots<
    | 'sidebar.workspaces.directoryFlow'
    | 'sidebar.workspaces.session.menu.item'
    | 'sidebar.workspaces.session.row.action'
    | 'sidebar.session.row.leading'
    | 'sidebar.session.row.hover'
  >
  & PropsStore<WorkspaceViewStoreHandle>
  & Omit<WorkspaceBrowserInjected, 'hooks'>
  & PropsHooks<WorkspaceBrowserInjected['hooks']>
  & PropsLocale<'workspace'>

/**
 * Picker-private injected share. Pick semantics remain in the owner's onPick
 * callback; this callback creates only the real Host Workspace. A type alias
 * supplies the implicit index signature required by the registry.
 */
export type WorkspacePickerInjected = DirectoryPickingInjected & {
  /** Adopt a picked host directory as a real Workspace before targeting a Session. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
}

/**
 * Full picker props: the owner share plus the creation callback and the
 * locale seat. The two picker holes (blank-session hero / New-Session view)
 * share one owner currency, so one composed type serves both registrations.
 */
export type WorkspacePickerProps =
  PropsRuntime<'conversation.hero.workspace'>
  & PropsRenderSlots<'conversation.hero.workspace.directoryFlow'>
  & Omit<WorkspacePickerInjected, 'hooks'>
  & PropsHooks<WorkspacePickerInjected['hooks']>
  & PropsLocale<'workspace'>
