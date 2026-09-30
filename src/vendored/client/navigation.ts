/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionCreateError,
  SessionReference,
  SessionTarget,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BaseWorkspaceRoute, RowToast, BaseWorkspaceMissingRequest } from './contract/slots.ts'
import { pinOrderAccounts, pinOrderSource } from './pin-order.ts'
import type { WorkspaceViewStoreActions } from './stores.ts'

interface MainSelection {
  readonly sessionId?: SessionId
  readonly subagentAddress?: SubagentAddress
}

/** Workspace archive and directory operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param target - known Session identity or durable direct-parent subagent address to display.
   */
  openSession(target: SessionTarget): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session,
   * skipped after supersession; a throw aborts the open and releases the retained reference.
   * @returns completion; a superseded request may create a Session but does not open it.
   * @throws on failure; a refused creation is also shown through the Workspace
   * notice unless a later navigation or disposal superseded the request.
   */
  openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>
  /**
   * Fork a Session without changing the current selection.
   * @param sessionId - source Session.
   * @param onCreated - observer before the optional child-title update.
   * @returns the child SessionId after creation and inherited-title increment.
   */
  forkSession(sessionId: SessionId, onCreated?: (childId: SessionId) => void): Promise<SessionId>
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * Start a New Session flow and navigate to its Session; a creation the Host
   * refuses is shown through the Workspace notice and leaves the selection as it was.
   * @param workspaceId - explicit target; absent targets the Host's default
   * Workspace, and does nothing when there is no default to resolve.
   * @param beforeOpen - optional synchronous preparation for the Session that
   * lands, run once it exists and before it becomes the main view. Best-effort:
   * a flow superseded mid-navigation never opens its Session, so this does not
   * run — which is the correct outcome for an abandoned click, since nothing was
   * opened to prepare. Absent, the flow is the fire-and-forget it always was.
   */
  startSession(workspaceId?: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): void
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Pin a Session on the Host, then lead it in its accounts' saved orders
   * (its Workspace group or Ungrouped, and the flat list). The order write
   * reads the memberships current at completion, so reorders that landed
   * while the Host call was pending keep their positions.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>
  /**
   * Unpin a Session on the Host; saved positions stay as they are.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>
  /**
   * Open the Host-native directory picker.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory(): Promise<string | null>
  /**
   * List one Host directory level.
   * @param path - directory path; absent selects the Host home.
   * @param signal - cancellation for a superseded scan.
   * @returns directory entries and breadcrumb ancestry.
   */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create a child directory.
   * @param path - existing parent directory.
   * @param name - child directory name.
   * @returns created absolute path.
   */
  createDirectory(path: string, name: string): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation and directory UI capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** @param rpcError - Host directory business failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  private readonly lifetime = new AbortController()
  private readonly selection = createSnapshotStore<MainSelection>(
    {}, { persist: { name: 'dsh.sessions.current' } },
  )
  private mainReference: SessionReference | undefined

  /**
   * @param ctx - Client root Context.
   * @param directoryPicker - the directory-picking Remote namespace.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   * @param view - the browser's viewing-store write set (one instance shared with its registration).
   * @param notify - show one notice through the Workspace notice channel.
   * @param placeUnscoped - optional destination for an unscoped New Session. The
   * caller decides where it goes; this service only supplies the Session that
   * landed and the one the user was looking at. Absent, the Session is left where
   * the default Workspace resolution put it, which is the shipped behaviour.
   * @param onBaseWorkspaceMissing - optional report for a New Session that could not
   * land because its 底层工作区 is gone. Absent, the flow is exactly the shipped one:
   * the click does nothing. The caller supplies the path, since deriving it needs a
   * Host query this service does not hold.
   * @param resolveBaseWorkspace - optional: where this plugin's 底层工作区 setting
   * points, for the entries that state no destination — the shell's New Session
   * button and its shortcut, ui-schedule, ui-agent-preset, and a caller-supplied
   * group's own ＋ (those groups carry no `workspaceId`; see `tree.ts`). The service
   * cannot answer this itself: the setting lives in the plugin's own domain, and
   * turning its stored **path** into a Workspace id needs a registry snapshot the
   * caller already holds.
   *
   * Synchronous by design. Both inputs are in-process observables
   * (`clientBaseWorkspace`, `workspaces.list`), so a promise here would put a
   * suspension point inside a click for no benefit. Absent — an unmodified
   * composition — the flow is exactly the shipped one.
   */
  constructor(
    ctx: Context,
    private readonly directoryPicker: ClientRemote['directoryPicker'],
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
    private readonly view: Pick<WorkspaceViewStoreActions, 'pinSessionOrder'>,
    private readonly notify: (toast: RowToast) => void,
    private readonly placeUnscoped?: (sessionId: SessionId, currentSessionId: SessionId | undefined) => void,
    private readonly onBaseWorkspaceMissing?: (request: BaseWorkspaceMissingRequest) => void,
    private readonly resolveBaseWorkspace?: () => BaseWorkspaceRoute,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => {
      const stop = this.watchNavigation()
      return () => {
        stop()
        this.lifetime.abort()
        const reference = this.mainReference
        this.mainReference = undefined
        reference?.release()
      }
    }, 'ui-workspace: Workspace navigation policy')
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight

    const attempt = this.reuseOrCreateBlank(workspace)
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  private reuseOrCreateBlank(workspace: WorkspaceView): Promise<SessionId> {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary === undefined || !summary.blank || summary.cwd !== workspace.path
        || !workspace.sessionIds.includes(id) || archived.includes(id)) continue
      return this.reuseBlank(workspace.workspaceId, id)
    }
    return this.sessions.create({ workspaceId: workspace.workspaceId })
  }

  private async reuseBlank(workspaceId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
    try {
      return await this.sessions.create({ workspaceId, sessionId })
    } catch (error: unknown) {
      if (sessionCreateErrorOf(error)?.rpcError.code !== 'session/writer-held') throw error
      return this.sessions.create({ workspaceId })
    }
  }

  openSession(target: SessionTarget): void {
    this.replaceMain(target, this.lifetime.signal, 'reveal')
  }

  async openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    let sessionId: SessionId
    try {
      sessionId = await this.connectWorkspace(workspaceId)
    } catch (error: unknown) {
      // Reported here, not in connectWorkspace: startup restoration calls that
      // directly and stays console-only.
      if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
      throw error
    }
    if (navigation.aborted) return
    this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
  }

  async forkSession(sessionId: SessionId, onCreated?: (childId: SessionId) => void): Promise<SessionId> {
    return this.sessions.fork({ sessionId, increaseTitle: true, ...onCreated === undefined ? {} : { onCreated } })
  }

  startSession(workspaceId?: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): void {
    // An explicit target is a real Workspace row asking for its own New
    // Session: unchanged.
    if (workspaceId !== undefined) {
      this.openNewSessionIn(workspaceId, beforeOpen)
      return
    }
    // This plugin's 底层工作区 setting governs every entry that states no destination.
    // Resolved per click, like the official default below it: caching a Workspace id
    // would outlive a registration that was deleted, and reporting exactly that is the
    // `'missing'` arm's whole purpose.
    const route = this.resolveBaseWorkspace?.()
    if (route?.kind === 'workspace') {
      // A stated destination, so it takes the shape a row's ＋ does: `beforeOpen` rides
      // along, which is what lets a Session land in the chosen Workspace *and* still be
      // filed. A project row files it under that project; the shell's button applies the
      // caller's placement policy. Returning early would create the Session and drop the
      // filing, so a project's ＋ would file into nothing.
      this.openNewSessionIn(route.workspaceId, beforeOpen)
      return
    }
    if (route?.kind === 'missing') {
      // The setting names a Workspace that is gone. Create nothing and say why: silently
      // using the official default would be indistinguishable from the setting being
      // ignored, which is precisely the defect this path exists to fix.
      this.onBaseWorkspaceMissing?.({ mode: 'specified', path: route.path, name: route.name })
      return
    }
    // `'official'`, or no callback at all: unchanged. This is also the cold-start path,
    // where the caller's model has not landed yet and the shipped behaviour is the only
    // safe answer.
    //
    // No target means every unscoped entry: the sidebar shell's New Session
    // button and its shortcut, ui-schedule, ui-agent-preset, and this plugin's
    // own caller-supplied groups. They all resolve the Host's default Workspace.
    // The shipped behaviour guessed instead — the current Session's Workspace,
    // then the most recently used one — which made the destination depend on
    // whatever the user last did.
    //
    // `beforeOpen` wins when it is present: a caller that states a destination
    // (a project row's ＋, the Ungrouped bucket's ＋) has already decided, and the
    // placement policy is only for the entries that state none.
    const prepared = beforeOpen ?? (this.placeUnscoped === undefined
      ? undefined
      : (sessionId: SessionId) => { this.placeUnscoped?.(sessionId, this.mainReference?.sessionId) })
    void this.startSessionInDefaultWorkspace(prepared)
  }

  /** Open the New Session flow in one already-known Workspace. */
  private openNewSessionIn(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
  ): void {
    void this.openWorkspace(workspaceId, beforeOpen).catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  /**
   * Resolve the Host's default Workspace, then start a Session in it.
   *
   * `initializeDefault` is a pure read once the registry records a default: it
   * returns the recorded entity before reaching any directory resolution, so
   * this creates and relocates nothing in normal use.
   *
   * Resolved per click rather than cached: a cached id would outlive a deleted
   * or replaced registration and then fail inside `connectWorkspace`, whereas a
   * stale read here simply resolves again.
   *
   * With no default Workspace to resolve (a deleted registration, or an install
   * ineligible for one) the click does nothing at all. It deliberately does not
   * fall back to another Workspace, and does not clear the current selection
   * the way the shipped guess did.
   * @param beforeOpen - preparation for the Session that lands; see
   * `startSession`. Skipped along with the whole flow when there is no default.
   */
  private async startSessionInDefaultWorkspace(
    beforeOpen?: (sessionId: SessionId) => void,
  ): Promise<void> {
    const prepared = await this.initializeDefaultWorkspace(this.lifetime.signal)
    if (prepared === undefined) {
      // The shipped flow stops here, and a click therefore had no visible effect at
      // all: an unresolvable default does not throw, so not even the failure notice
      // fires (that notice belongs to the *throwing* path, which the host-lookup
      // test pins). Reporting it is what turns a dead click into a decision.
      //
      // `path` is left to the caller: only the Host can derive the default
      // Workspace's directory, and `UiWorkspaceService` deliberately has no Remote
      // of its own beyond the directory picker.
      this.onBaseWorkspaceMissing?.({ mode: 'default', path: null, name: null })
      return
    }
    this.openNewSessionIn(prepared.workspaceId, beforeOpen)
  }

  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    await this.workspaces.archiveSession(sessionId, options)
    if (this.mainReference?.sessionId === sessionId) this.clearMain()
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.pinSession(sessionId)
    const { items, pinnedSessionIds, archivedSessionIds } = this.workspaces.list.getSnapshot()
    this.view.pinSessionOrder(
      sessionId,
      pinOrderAccounts(items, sessionId),
      pinOrderSource(items, this.sessions.list.getSnapshot(), { pinnedSessionIds, archivedSessionIds }),
    )
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unpinSession(sessionId)
  }

  async pickDirectory(): Promise<string | null> {
    const result = await this.directoryPicker.pick()
    if (!result.ok) throw new Error(`directory picker failed: ${result.error.message}`)
    return result.value
  }

  async listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const result = await this.directoryPicker.list(path, signal)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  async createDirectory(path: string, name: string): Promise<string> {
    const result = await this.directoryPicker.createDirectory(path, name)
    if (!result.ok) throw new DirectoryBrowseError(result.error)
    return result.value
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (initial !== 'waiting') return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (this.mainReference !== undefined) {
        initial = 'done'
        return
      }
      initial = 'connecting'
      void this.restoreSelection(workspace, sessions).then(
        () => { initial = 'done' },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial Session restoration failed:', reason)
        },
      )
    }

    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  private async restoreSelection(workspaces: WorkspaceSnapshot, sessions: SessionListState): Promise<void> {
    const saved = this.selection.getSnapshot()
    if (saved.subagentAddress !== undefined) {
      this.replaceMain(saved.subagentAddress, this.lifetime.signal, 'preserve')
      return
    }
    const summary = saved.sessionId === undefined ? undefined : sessions.byId[saved.sessionId]
    const workspace = summary === undefined ? undefined
      : workspaces.items.find(item => item.sessionIds.includes(summary.id))
    if (summary !== undefined && (!summary.blank || workspace === undefined)) {
      this.replaceMain(summary.id, this.lifetime.signal, 'preserve')
      return
    }
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    let sessionId: SessionId | undefined
    if (summary !== undefined && workspace !== undefined && summary.cwd === workspace.path
      && !workspaces.archivedSessionIds.includes(summary.id)) {
      sessionId = await this.reuseBlank(workspace.workspaceId, summary.id)
    }
    let target = workspace?.workspaceId ?? recentWorkspace(workspaces.items, sessions.byId)
    if (target === undefined && workspaces.items.length === 0 && sessions.ids.length === 0) {
      const prepared = await this.initializeDefaultWorkspace(navigation)
      if (navigation.aborted) return
      target = prepared?.workspaceId
    }
    if (sessionId === undefined && target !== undefined) sessionId = await this.connectWorkspace(target)
    if (sessionId !== undefined && !navigation.aborted) {
      this.replaceMain(sessionId, navigation, 'preserve')
    }
  }

  private async initializeDefaultWorkspace(signal: AbortSignal): Promise<WorkspaceView | undefined> {
    try {
      return await this.workspaces.initializeDefault(signal)
    } catch (_error: unknown) {
      if (!signal.aborted) this.notify({ kind: 'defaultWorkspaceFailed' })
      return undefined
    }
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.mainReference?.sessionId
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.clearMain()
    return true
  }

  private clearMain(): void {
    const previous = this.mainReference
    this.mainReference = undefined
    this.selection.set({})
    previous?.release()
    this.ctx.layout.selectPanel(null)
  }

  private replaceMain(
    target: SessionTarget,
    signal: AbortSignal,
    panel: 'reveal' | 'preserve',
    beforeOpen?: (sessionId: SessionId) => void,
  ): void {
    signal.throwIfAborted()
    const reference = this.sessions.retain(target, { source: 'mainView' })
    try {
      signal.throwIfAborted()
      beforeOpen?.(reference.sessionId)
      if (signal.aborted) {
        reference.release()
        return
      }
      const subagentAddress = typeof target === 'string'
        ? this.sessions.subagentAddress(reference.sessionId)
        : target
      this.selection.set({
        sessionId: reference.sessionId,
        ...(subagentAddress === undefined ? {} : { subagentAddress }),
      })
    } catch (error: unknown) {
      reference.release()
      throw error
    }
    const previous = this.mainReference
    this.mainReference = reference
    previous?.release()
    if (panel === 'reveal') this.ctx.layout.selectPanel(null)
  }

}

/**
 * `error` as the Session Controller's creation failure, or undefined when it
 * is not one. Client plugin bundles do not share error-class identity, so the
 * name decides.
 */
function sessionCreateErrorOf(error: unknown): SessionCreateError | undefined {
  return error instanceof Error && error.name === 'SessionCreateError' ? error as SessionCreateError : undefined
}

/**
 * The words a failed Session creation is reported in: a Host refusal keeps its
 * stable code and message; any other failure keeps its own message.
 */
function creationFailureMessage(error: unknown): string {
  const refused = sessionCreateErrorOf(error)
  if (refused !== undefined) return `${refused.rpcError.code}: ${refused.rpcError.message}`
  return error instanceof Error ? error.message : String(error)
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export { UiWorkspaceService }
