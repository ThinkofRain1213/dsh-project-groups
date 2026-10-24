/** Workspace archive and directory UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClientRemote, DirectoryListing, RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions,
  SessionCreateError,
  SessionBinding,
  SessionReference,
  SessionTarget,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the `agentPreset` Session projection value into this program.
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DraftInitializationOptions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BaseWorkspaceRoute, RowToast, BaseWorkspaceMissingRequest } from './contract/slots.ts'
import { pinOrderAccounts, pinOrderSource } from './pin-order.ts'
import type { WorkspaceViewStoreActions } from './stores.ts'

interface MainSelection {
  readonly sessionId?: SessionId
  readonly subagentAddress?: SubagentAddress
}

/** Content preparation and Agent preset for the Session a Workspace flow opens. */
export interface StartSessionOptions extends DraftInitializationOptions {
  /** Agent preset the Session runs; the Host default when omitted. */
  readonly agentPreset?: string
}

/**
 * `startSession`'s second parameter, in either of its two shapes.
 *
 * Upstream's signature is `startSession(workspaceId?, options?)`. This fork needs a
 * `beforeOpen` seam in the same position so a project row can file the Session it just
 * created, and it originally spent that slot on the callback alone. That was wrong in a
 * way no gate noticed: upstream callers pass an **options object** there — `ui-agent-preset`
 * has since 0.2.1-rc.1, and rc.3 added `ui-entry-customization`, whose only job is to open a
 * Session with a prepared prompt and preset.
 *
 * An object arriving where a function was expected throws `beforeOpen is not a function`
 * *after* the Session has been created, so the user got an empty Session and no notice.
 *
 * The union is what makes both contracts hold at once, and it keeps the rule this tree
 * lives by: a caller who passes neither still gets the official behaviour.
 */
export type StartSessionSecondParameter =
  | ((sessionId: SessionId) => void)
  | StartSessionOptions

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
   * @param options - choices for the Session the connection creates or reuses.
   * @returns completion; a superseded request may create a Session but does not open it.
   * @throws on failure; a refused creation is also shown through the Workspace
   * notice unless a later navigation or disposal superseded the request.
   */
  openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options?: Pick<StartSessionOptions, 'agentPreset'>,
  ): Promise<void>
  /**
   * Fork a Session without changing the current selection.
   * @param sessionId - source Session.
   * @param onCreated - observer before the optional child-title update.
   * @param options - optional permission to start source migration; omission preserves the Host default.
   * @returns the child SessionId after creation and inherited-title increment.
   */
  forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration'>,
  ): Promise<SessionId>
  /**
   * Resolve the Session for a new conversation in a Workspace: navigation names the first
   * reusable blank member, skipping blanks that list a preset other than a requested one, and
   * the Host reuses it under the requested preset or its default, or creates another Session.
   * @param workspaceId - target Workspace.
   * @param options - choices for the created or reused Session.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId, options?: Pick<StartSessionOptions, 'agentPreset'>): Promise<SessionId>
  /**
   * Open the Workspace blank `connectWorkspace` resolves, so New Session returns to that blank's
   * unsent draft. A creation the Host refuses is shown through the Workspace notice and leaves the
   * selection as it was.
   * @param workspaceId - explicit target; absent resolves this plugin's
   * 底层工作区 policy, then falls back to the Host's own resolution.
   * @param beforeOpen - optional synchronous preparation for the Session that
   * lands, run once it exists and before it becomes the main view. Best-effort:
   * a flow superseded mid-navigation never opens its Session, so this does not
   * run — which is the correct outcome for an abandoned click, since nothing was
   * opened to prepare. Absent, the flow is the fire-and-forget it always was.
   * @param options - initial content, the blank's preset, and `whenDraftExists`, which decides
   * whether existing text or attachments are kept, replaced, or followed by the prompt.
   */
  startSession(
    workspaceId?: WorkspaceId,
    beforeOpenOrOptions?: StartSessionSecondParameter,
    options?: StartSessionOptions,
  ): void
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
  /** The latest in-flight connection per Workspace; a request joins it only when both name the same preset. */
  private readonly connecting = new Map<WorkspaceId, {
    readonly agentPreset: string | undefined
    readonly attempt: Promise<SessionId>
  }>()
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
   * @param onNewSession - optional report that a New Session flow just landed, called
   * with the Session before it is opened. Every entry passes through {@link startSession}
   * — the shell's button and its shortcut, ui-schedule, ui-agent-preset, a project row's
   * ＋, the Ungrouped bucket's ＋, and creating a project — so this is the one place that
   * can say "what lands next is new" without six callers repeating it, and it is what
   * lets the sidebar fade that row in. Separate from `beforeOpen` because the two answer
   * different questions: `beforeOpen` decides *where* a Session belongs, this one says
   * *that it is new*. A caller may supply either, both, or neither.
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
    private readonly onNewSession?: (sessionId: SessionId) => void,
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

  connectWorkspace(workspaceId: WorkspaceId, options: Pick<StartSessionOptions, 'agentPreset'> = {}): Promise<SessionId> {
    return this.connectBlank(workspaceId, options)
  }

  /**
   * @param reuse - preset for the reused or created blank.
   */
  private async connectBlank(
    workspaceId: WorkspaceId,
    reuse: Pick<StartSessionOptions, 'agentPreset'>,
  ): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined && inflight.agentPreset === reuse.agentPreset) return inflight.attempt

    const attempt = this.createInWorkspace(workspace, reuse).finally(() => {
      if (this.connecting.get(workspaceId)?.attempt === attempt) this.connecting.delete(workspaceId)
    })
    this.connecting.set(workspaceId, { agentPreset: reuse.agentPreset, attempt })
    return attempt
  }

  /** Name the first reusable member blank; a requested preset also skips blanks listing another preset. */
  private createInWorkspace(workspace: WorkspaceView, options: Pick<StartSessionOptions, 'agentPreset'>): Promise<SessionId> {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    const blank = sessions.ids.find((id) => {
      const summary = sessions.byId[id]
      const listed = summary?.projectionValues?.agentPreset
      return summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(id) && !archived.includes(id)
        && (options.agentPreset === undefined || typeof listed !== 'string' || listed === options.agentPreset)
    })
    return this.createNamed({
      workspaceId: workspace.workspaceId,
      ...(blank === undefined ? {} : { sessionId: blank }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    })
  }

  /**
   * Create through the Host. A named blank the Host declined may still read as
   * blank from stale cached list metadata, which hides it from the Session tree;
   * its projections are reloaded so the row reflects its log.
   */
  private async createNamed(request: {
    readonly workspaceId: WorkspaceId
    readonly sessionId?: SessionId
    readonly agentPreset?: string
  }): Promise<SessionId> {
    const sessionId = await this.sessions.create(request)
    const named = request.sessionId
    if (named !== undefined && named !== sessionId) {
      void this.sessions.refreshProjections(named).catch((reason: unknown) => {
        console.warn('declined blank Session projection reload failed:', reason)
      })
    }
    return sessionId
  }

  /**
   * Reopen a saved blank Session under the preset its log recorded, or under
   * the Host default once that preset no longer activates. Listed values are
   * cached hints that can lag the log after an unclean Host exit, so the
   * Session's projections are reloaded before the preset is read; a Session
   * that still awaits a format migration reloads only those cached hints.
   */
  private async restoreBlank(workspaceId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
    await this.sessions.refreshProjections(sessionId)
    const recorded = this.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
    const request = { workspaceId, sessionId }
    if (typeof recorded !== 'string') return this.createNamed(request)
    try {
      return await this.createNamed({ ...request, agentPreset: recorded })
    } catch (error: unknown) {
      const code = sessionCreateErrorOf(error)?.rpcError.code
      if (code !== 'agent-preset/not-found' && code !== 'agent-preset/invalid') throw error
      return this.createNamed(request)
    }
  }

  openSession(target: SessionTarget): void {
    this.replaceMain(target, this.lifetime.signal, 'reveal')
  }

  openWorkspace(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options: Pick<StartSessionOptions, 'agentPreset'> = {},
  ): Promise<void> {
    return this.openWorkspaceSession(workspaceId, beforeOpen, options)
  }

  private async openWorkspaceSession(
    workspaceId: WorkspaceId,
    beforeOpen: ((sessionId: SessionId) => void) | undefined,
    reuse: Pick<StartSessionOptions, 'agentPreset'>,
  ): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    let sessionId: SessionId
    try {
      sessionId = await this.connectBlank(workspaceId, reuse)
    } catch (error: unknown) {
      // Reported here, not in connectWorkspace: startup restoration calls that
      // directly and stays console-only.
      if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
      throw error
    }
    if (navigation.aborted) return
    this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
  }

  async forkSession(
    sessionId: SessionId,
    onCreated?: (childId: SessionId) => void,
    options?: Pick<Parameters<ISessions['fork']>[0], 'allowMigration'>,
  ): Promise<SessionId> {
    return this.sessions.fork({
      sessionId,
      increaseTitle: true,
      ...onCreated === undefined ? {} : { onCreated },
      ...options?.allowMigration === undefined ? {} : { allowMigration: options.allowMigration },
    })
  }

  startSession(
    workspaceId?: WorkspaceId,
    beforeOpenOrOptions?: StartSessionSecondParameter,
    options?: StartSessionOptions,
  ): void {
    // Two callers, one slot. Upstream's second parameter is the options object; this
    // fork's is `beforeOpen`. Dispatch on the shape rather than picking a side, so an
    // upstream caller (`ui-agent-preset`, and rc.3's `ui-entry-customization`) and a
    // project row both work. Without this, an object arrives where a function is
    // expected and `beforeOpen?.(sessionId)` throws **after** the Session exists —
    // the user gets an empty Session, no preset, no prompt, and no notice.
    //
    // `typeof x === 'function'` is the discriminator because the two shapes cannot
    // overlap: an options object is never callable, and a callback never carries
    // `prompt` / `agentPreset`. Passing neither still takes the official path.
    const beforeOpen = typeof beforeOpenOrOptions === 'function' ? beforeOpenOrOptions : undefined
    const resolvedOptions = typeof beforeOpenOrOptions === 'function'
      ? options
      : beforeOpenOrOptions ?? options

    // Upstream's half: what the Session starts with. Split first, because
    // `agentPreset` travels a different route than the draft content.
    const { agentPreset, ...draft } = resolvedOptions ?? {}
    const draftOptions = resolvedOptions === undefined ? undefined : draft
    const initializeDraft = draftOptions !== undefined && (draftOptions.prompt !== undefined
      || (draftOptions.whenDraftExists ?? (draftOptions.clearPreviousDraft === true ? 'replace' : 'keep')) === 'replace')

    // This plugin's half: where the Session belongs. `beforeOpen` decides that,
    // and `onNewSession` announces the landing so the sidebar can fade the row in.
    // Composed rather than merged: a caller may supply either, both, or neither.
    const announce = (sessionId: SessionId): void => {
      this.onNewSession?.(sessionId)
    }
    const draftPreparation = initializeDraft && draftOptions !== undefined
      ? (sessionId: SessionId): void => {
        const binding = this.sessions.binding(sessionId)
        if (binding === undefined) this.draftPreparationFailed()
        this.prepareDraft(binding, draftOptions)
      }
      : undefined
    // One callback for both upstream's draft preparation and this plugin's filing:
    // `openWorkspace` runs a single `beforeOpen`, so the two must compose here.
    const withBeforeOpen = (sessionId: SessionId): void => {
      announce(sessionId)
      beforeOpen?.(sessionId)
      draftPreparation?.(sessionId)
    }
    const presetOptions = agentPreset === undefined ? {} : { agentPreset }

    // An explicit target is a real Workspace row asking for its own New
    // Session: unchanged, except that draft options now ride along.
    if (workspaceId !== undefined) {
      this.openNewSessionIn(workspaceId, withBeforeOpen, presetOptions)
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
      this.openNewSessionIn(route.workspaceId, withBeforeOpen, presetOptions)
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
    const place = beforeOpen ?? (this.placeUnscoped === undefined
      ? undefined
      : (sessionId: SessionId) => { this.placeUnscoped?.(sessionId, this.mainReference?.sessionId) })
    void this.startSessionInDefaultWorkspace(
      place === undefined && draftPreparation === undefined
        ? announce
        : (sessionId: SessionId) => { announce(sessionId); place?.(sessionId); draftPreparation?.(sessionId) },
      presetOptions,
      draftPreparation !== undefined,
    )
  }

  /** Open the New Session flow in one already-known Workspace. */
  private openNewSessionIn(
    workspaceId: WorkspaceId,
    beforeOpen?: (sessionId: SessionId) => void,
    options?: Pick<StartSessionOptions, 'agentPreset'>,
  ): void {
    void this.openWorkspace(workspaceId, beforeOpen, options).catch(
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
   * @param options - the Agent preset for the Session the flow opens.
   * @param draftRequested - the caller asked for content to be prepared, which
   * turns "no Workspace to land in" into a refusal it can act on rather than a
   * silently dead click.
   */
  private async startSessionInDefaultWorkspace(
    beforeOpen?: (sessionId: SessionId) => void,
    options?: Pick<StartSessionOptions, 'agentPreset'>,
    draftRequested = false,
  ): Promise<void> {
    const prepared = await this.initializeDefaultWorkspace(this.lifetime.signal)
    switch (prepared.kind) {
      case 'ready':
        this.openNewSessionIn(prepared.workspace.workspaceId, beforeOpen, options)
        return
      case 'absent':
        // A caller that asked for draft content has something specific to say: there is
        // nowhere to put it. Upstream answers exactly this way before it reaches the
        // default-Workspace resolution; keeping it here means the refusal survives the
        // base-workspace policy this plugin puts in front of that resolution.
        if (draftRequested) {
          this.notify({
            kind: 'createFailed',
            message: this.ctx.locale.bind('workspace')('draft.workspaceRequired'),
          })
          return
        }
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
      // `failed` — the lookup threw and already fired its own notice.
      // `aborted` — the service was disposed mid-flight, so there is no outcome to
      // report at all.
      //
      // Neither is "the setting names a Workspace that is gone", which is what
      // `onBaseWorkspaceMissing` means. Reporting them as such told the user to
      // re-point a setting that was never wrong, and in the `failed` case doubled up
      // with the notice `initializeDefaultWorkspace` had already raised.
      case 'failed':
      case 'aborted':
        return
    }
  }

  private prepareDraft(binding: SessionBinding, options: DraftInitializationOptions): void {
    const conversation = this.ctx.get('conversation')
    if (conversation === undefined) this.draftPreparationFailed()
    if (conversation.input.requestDraftInitialization(binding, options) === 'blocked') this.draftPreparationFailed()
  }

  private draftPreparationFailed(): never {
    const message = this.ctx.locale.bind('workspace')('draft.initializationFailed')
    this.notify({ kind: 'createFailed', message })
    throw new Error(message)
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
      sessionId = await this.restoreBlank(workspace.workspaceId, summary.id)
    }
    let target = workspace?.workspaceId ?? recentWorkspace(workspaces.items, sessions.byId)
    if (target === undefined && workspaces.items.length === 0 && sessions.ids.length === 0) {
      const prepared = await this.initializeDefaultWorkspace(navigation)
      if (navigation.aborted) return
      // Only the `ready` arm carries a Workspace; the other three leave `target` undefined,
      // which this cold-start path already handles by doing nothing further.
      target = prepared.kind === 'ready' ? prepared.workspace.workspaceId : undefined
    }
    if (sessionId === undefined && target !== undefined) sessionId = await this.connectWorkspace(target)
    if (sessionId !== undefined && !navigation.aborted) {
      this.replaceMain(sessionId, navigation, 'preserve')
    }
  }

  /**
   * Resolve the Host's default Workspace.
   *
   * The return is a **discriminated union** rather than `WorkspaceView | undefined`, because
   * `undefined` conflated three different outcomes and its caller reported all three the same
   * way — as "the setting names a Workspace that is gone":
   *
   * - `ready`   — resolved; start a Session in it.
   * - `absent`  — there genuinely is no default to resolve. This is the one case the
   *               missing-workspace report is about.
   * - `failed`  — the lookup threw. `initializeDefault` failing already raised its own
   *               `defaultWorkspaceFailed` notice, so reporting it again as "the setting names
   *               a Workspace that is gone" doubled up and named the wrong problem.
   * - `aborted` — the service was disposed mid-flight; there is no outcome to report at all,
   *               and the shipped flow simply does nothing.
   *
   * Only `ready` carries a Workspace, so a caller cannot read one without having checked.
   * @param signal - aborts with the service's lifetime.
   * @returns which of the four outcomes occurred.
   */
  private async initializeDefaultWorkspace(
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'ready'; readonly workspace: WorkspaceView }
    | { readonly kind: 'absent' }
    | { readonly kind: 'failed' }
    | { readonly kind: 'aborted' }
  > {
    try {
      const workspace = await this.workspaces.initializeDefault(signal)
      // `initializeDefault` answering `undefined` is the genuine "no default" case.
      return workspace === undefined ? { kind: 'absent' } : { kind: 'ready', workspace }
    } catch (_error: unknown) {
      // Disposal is not a failure: nothing is wrong, and nothing should be reported.
      if (signal.aborted) return { kind: 'aborted' }
      this.notify({ kind: 'defaultWorkspaceFailed' })
      return { kind: 'failed' }
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
