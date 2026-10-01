/**
 * The project model this plugin's sidebar is a view of.
 *
 * ## Where the data lives
 *
 * The Host owns it: `src/index.ts` keeps the durable table under
 * `$DSH_HOME/storages/`, and this class mirrors the projection it streams.
 *
 * ## Optimistic writes
 *
 * Most verbs call the Remote method and let the resulting `follow` frame update
 * the state, so the sidebar can never show a project the Host did not accept.
 *
 * Five are optimistic instead, because the interaction they serve is a **direct
 * manipulation the user is watching**: a state that only lands after a round trip
 * reads as lag — or, for an assignment, as the row rendering under the project it
 * is leaving before gliding to the one it is joining.
 *
 *   - `assign` / `unassign` — a drag, a drop, and a New Session's filing;
 *   - `setExpanded` — folding a row;
 *   - `setOrders` — a sort gesture;
 *   - `setNewSessionTarget` — the settings card;
 *   - `setBaseWorkspace` — the settings card's base-workspace choice.
 *
 * Each writes locally first, notifies, then calls the Host, and reverts **only
 * when no newer local value has superseded it**, which keeps a slow refusal from
 * undoing a fast correction. `assign`/`unassign` additionally hold their writes in
 * {@link ProjectModel.pendingPlacements} until the Host echoes them, because a
 * baseline produced *before* the write would otherwise undo it for one render.
 * The Host stays authoritative throughout: `follow` replaces this state wholesale.
 *
 * The judgement, in one line: **optimistic when the user is watching the
 * consequence of their own gesture.** Everything else waits for the Host.
 *
 * ## Why the grouping observable caches its snapshot
 *
 * The vendored browser's selector compares snapshot identity, so a fresh array
 * per read would re-render every consumer on each store ping. The derived
 * `GroupSource[]` is therefore rebuilt only when the projection actually
 * changes, which is the same discipline the shipped `derive()` helper enforces.
 *
 * Because the groups are derived from the assignment map, every write to that map
 * must invalidate this cache — see {@link ProjectModel.applyAssignments}.
 *
 * ## Why Ungrouped is the fallback rather than a project
 *
 * A Session with no assignment is not in any project, and an empty source is a
 * meaningful override: `undefined` would mean "group by the Host Workspace
 * registry" (upstream), while `[]` means "an active override claiming nothing".
 * Projects plus the browser's own Ungrouped bucket is therefore the whole list.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupSource } from '../vendored/client/tree.ts'
import type {
  BaseWorkspaceSetting, NewSessionTarget, ProjectBaseline, ProjectFollowFrame,
  ProjectRebuildBaseWorkspaceValue, ProjectValue,
} from '../protocol.ts'
import { withDefaultMode } from '../protocol.ts'

/** The Remote face this model drives; structurally the mounted namespace. */
export interface ProjectRemote {
  baseline(): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>
  create(request: { title: string }): Promise<RemoteOutcome<unknown>>
  rename(request: { projectId: string; title: string }): Promise<RemoteOutcome<unknown>>
  delete(request: { projectId: string }): Promise<RemoteOutcome<unknown>>
  reorder(request: { projectId: string; beforeId?: string }): Promise<RemoteOutcome<unknown>>
  assign(request: { sessionId: string; projectId: string }): Promise<RemoteOutcome<unknown>>
  unassign(request: { sessionId: string }): Promise<RemoteOutcome<unknown>>
  setExpanded(request: { projectId: string; expanded: boolean }): Promise<RemoteOutcome<unknown>>
  setOrders(request: { orders: Readonly<Record<string, readonly string[]>> }): Promise<RemoteOutcome<unknown>>
  setNewSessionTarget(request: { target: NewSessionTarget }): Promise<RemoteOutcome<unknown>>
  setCreateOpensSession(request: { value: boolean }): Promise<RemoteOutcome<unknown>>
  setBaseWorkspace(request: BaseWorkspaceSetting): Promise<RemoteOutcome<unknown>>
  defaultWorkspacePath(): Promise<RemoteOutcome<{ path: string | null }>>
  rebuildBaseWorkspace(): Promise<RemoteOutcome<unknown>>
}

/** Minimal result shape the mounted namespace answers with. */
interface RemoteOutcome<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly message: string }
}

/** Everything the sidebar needs to render projects, as the Host reports it. */
interface ProjectState {
  readonly projects: readonly ProjectValue[]
  /** Session id → owning project id. */
  readonly assignments: Readonly<Record<string, string>>
  /**
   * Project id → whether its row is open. An **absent** entry means the user has
   * never touched that row, which is a different state from `false`; the browser
   * opens the group holding the current Session only while the entry is absent.
   */
  readonly expansions: Readonly<Record<string, boolean>>
  /**
   * Project id → the manual order of its members. An **absent** entry means the
   * project has no manual order, so member position comes from recency — which is
   * exactly what recency ordering wants.
   */
  readonly orders: Readonly<Record<string, readonly string[]>>
  /**
   * Where a New Session with no stated destination lands.
   *
   * Read through {@link ProjectModel.target} by the placement policy. A project
   * row's ＋ and the Ungrouped bucket's ＋ state their own destination and never
   * consult it.
   */
  readonly newSessionTarget: NewSessionTarget
  /**
   * The Workspace every New Session this plugin opens lands in.
   *
   * Read by the settings card, and by `resolveBaseWorkspace` in `src/client/index.ts`,
   * which turns it into where an unscoped New Session actually lands. `'default'` means
   * the official first-use Workspace; `'specified'` means the Workspace at the stored
   * `path`.
   */
  readonly baseWorkspace: BaseWorkspaceSetting
  /**
   * Whether creating a project also opens a Session inside it.
   *
   * Read by the vendored sidebar region — where the create dialog lives — to choose
   * between following the official add-workspace flow and only adding the row.
   */
  readonly createOpensSession: boolean
}

const EMPTY_STATE: ProjectState = Object.freeze({
  projects: Object.freeze([]),
  assignments: Object.freeze({}),
  expansions: Object.freeze({}),
  orders: Object.freeze({}),
  newSessionTarget: 'ungrouped',
  baseWorkspace: Object.freeze({ mode: 'default' as const }),
  createOpensSession: true,
})

/**
 * Field-wise equality for a base-workspace setting.
 *
 * Identity cannot be used: every `follow` frame lands a fresh object, so a card that
 * re-writes the mode it is already on would issue a redundant round trip on each
 * render. `name` is compared too — two Workspaces may share a title, so mode+path
 * alone would read a switch between them as no change.
 * @param left - one setting.
 * @param right - the other.
 * @returns whether the two would store the same value.
 */
function sameBaseWorkspace(left: BaseWorkspaceSetting, right: BaseWorkspaceSetting): boolean {
  return left.mode === right.mode
    && (left.path ?? '') === (right.path ?? '')
    && (left.name ?? '') === (right.name ?? '')
}

/** Unwrap one Remote outcome, turning a failure into a thrown error. */
function unwrap<T>(outcome: RemoteOutcome<T>, what: string): T {
  if (!outcome.ok) throw new Error(outcome.error?.message ?? `${what} failed`)
  return outcome.value as T
}

/**
 * Client-side projection of the Host's project registry.
 *
 * A single instance is shared with the sidebar's inject face; see
 * `src/client/index.ts`.
 */
export class ProjectModel {
  private state: ProjectState = EMPTY_STATE
  private derived: readonly GroupSource[] | undefined
  private readonly listeners = new Set<() => void>()
  /**
   * Placements written locally but not yet echoed by the Host.
   *
   * Session id → the target the user chose (`undefined` for Ungrouped) and the
   * token of that particular write. Overlaid onto every incoming baseline while
   * it lives: a frame produced *before* our write carries the previous owner, and
   * letting it through would revert the row for one render — the very move the
   * optimistic write exists to prevent.
   *
   * The **token**, not the value, identifies a write. Two writes of the *same*
   * target can be in flight for one Session (B → A → B), and the oldest one
   * failing must not clear the newest one's entry.
   *
   * Entries are retired when the Host echoes them, which is what makes this
   * self-terminating: the Host re-projects a full baseline after every landed
   * write, so "the frame carries our value" is "our write has landed". No timer.
   *
   * Known limit: a write the Host accepts but never echoes leaves its entry in
   * place, pinning that one Session's owner locally. The preconditions that make
   * this harmless are that the owner is written only through this class and that
   * one client is connected. If either stops holding, the fix is a generation
   * number on the baseline — not a timeout.
   */
  private readonly pendingPlacements = new Map<SessionId, { readonly projectId: string | undefined; readonly token: number }>()
  /** Monotonic write id; see {@link pendingPlacements}. */
  private placementSeq = 0

  /**
   * @param remote - the mounted `projectGroups` namespace.
   */
  constructor(private readonly remote: ProjectRemote) {}

  /**
   * The grouping source handed to the vendored browser.
   *
   * Never `undefined`: see the module doc on why "no override" is a different
   * state from "an override with nothing in it".
   */
  readonly grouping: HostObservable<readonly GroupSource[] | undefined> = {
    getSnapshot: () => this.groupingSnapshot(),
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /**
   * The recorded expansion of each project row.
   *
   * Served from this plugin's own Host domain rather than the browser's view
   * store, because that store is shared with the official plugin and its mount
   * prunes every non-Workspace key — which is what losing the state on a plugin
   * switch actually was.
   *
   * Only touched rows appear. The browser reads absence as "never opened", which
   * is what lets it auto-open the group holding the current Session once.
   */
  readonly expansions: HostObservable<Readonly<Record<string, boolean>>> = {
    getSnapshot: () => this.state.expansions,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /**
   * The recorded manual order of each project's members.
   *
   * Served from this plugin's own Host domain for the same reason as
   * {@link expansions}: the browser's view store is shared with the official
   * plugin, whose mount prunes every key that is not a Workspace id.
   *
   * Only projects with a recorded order appear. A missing entry means "derive
   * position from recency", which is not the same as an empty list.
   */
  readonly orders: HostObservable<Readonly<Record<string, readonly string[]>>> = {
    getSnapshot: () => this.state.orders,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /**
   * Where an unscoped New Session lands.
   *
   * Unlike {@link grouping}, {@link expansions} and {@link orders}, this is never
   * handed to the vendored browser: the sidebar renders groups and knows nothing
   * about New Session destinations. It exists for the settings card and for the
   * placement policy, both of which live in `src/client/`.
   */
  readonly newSessionTarget$: HostObservable<NewSessionTarget> = {
    getSnapshot: () => this.state.newSessionTarget,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /**
   * The base-workspace setting, for the settings card.
   *
   * Its own observable for the same reason as {@link newSessionTarget$}: it is a seat
   * the card reads with its own hook, and it is never handed to the vendored browser,
   * which renders groups and has no business knowing where Sessions land.
   */
  readonly baseWorkspace$: HostObservable<BaseWorkspaceSetting> = {
    getSnapshot: () => this.state.baseWorkspace,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /**
   * Whether creating a project opens a Session.
   *
   * Its own observable like the two above, with one difference worth stating: this
   * one **is** handed to the vendored browser, because the create dialog lives there
   * and that is where the value is spent. The settings card reads the same
   * observable, which is what keeps one switch driving the behaviour the user sees.
   */
  readonly createOpensSession$: HostObservable<boolean> = {
    getSnapshot: () => this.state.createOpensSession,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /** @returns whether creating a project also opens a Session inside it. */
  createOpensSessionValue(): boolean {
    return this.state.createOpensSession
  }

  /** @returns projects in display order. */
  list(): readonly ProjectValue[] {
    return this.state.projects
  }

  /** @returns the project with this id, or undefined. */
  get(id: string): ProjectValue | undefined {
    return this.state.projects.find(project => project.projectId === id)
  }

  /** @returns the id of the project owning this Session, or undefined. */
  projectOf(sessionId: SessionId): string | undefined {
    return this.state.assignments[sessionId]
  }

  /** @returns the Session ids filed under this project, in no particular order. */
  membersOf(projectId: string): readonly SessionId[] {
    return Object.entries(this.state.assignments)
      .filter(([, owner]) => owner === projectId)
      .map(([sessionId]) => sessionId as SessionId)
  }

  /** @returns where an unscoped New Session should land. */
  target(): NewSessionTarget {
    return this.state.newSessionTarget
  }

  /** @returns the stored base-workspace setting. */
  baseWorkspaceSetting(): BaseWorkspaceSetting {
    return this.state.baseWorkspace
  }

  /**
   * Load the Host's current projection and subscribe to its changes.
   * @returns a disposer that stops following.
   */
  async start(): Promise<() => void> {
    const baseline = await this.remote.baseline()
    if (!baseline.ok) throw new Error(baseline.error?.message ?? 'project baseline failed')
    this.accept(baseline.value as ProjectBaseline)

    // `follow` answers a stream handle rather than a promise; the shape is the
    // Gateway's, so it is read structurally here to keep this file free of a
    // platform-module import.
    const handle = this.remote as unknown as {
      follow(signal: AbortSignal): AsyncIterable<ProjectFollowFrame>
    }
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const frame of handle.follow(controller.signal)) this.acceptFrame(frame)
      } catch (error: unknown) {
        // A dropped carrier is recoverable (the Gateway reopens the stream), so
        // this is logged rather than surfaced: the sidebar keeps the last
        // projection, and a reconnect delivers a fresh baseline.
        console.warn('project stream ended:', error)
      }
    })()
    return () => { controller.abort() }
  }

  /**
   * Create a project and return its id.
   *
   * The id is returned because the caller needs it immediately: the official
   * add-workspace flow opens a Session as part of creating the row, and filing that
   * Session under the new project requires its id. It cannot be read back from state,
   * because the Host's `follow` frame has not necessarily landed when this resolves.
   * @param title - display title; surrounding whitespace is trimmed.
   * @returns the created project's id.
   */
  async create(title: string): Promise<string> {
    const value = unwrap(await this.remote.create({ title: title.trim() }), 'create project')
    return (value as { project: { projectId: string } }).project.projectId
  }

  /** Retitle a project. */
  async rename(projectId: string, title: string): Promise<void> {
    unwrap(await this.remote.rename({ projectId, title: title.trim() }), 'rename project')
  }

  /** Delete a project; its Sessions return to Ungrouped on the Host. */
  async remove(projectId: string): Promise<void> {
    unwrap(await this.remote.delete({ projectId }), 'delete project')
  }

  /** Move a project before another; an absent anchor appends. */
  async reorder(projectId: string, beforeId?: string): Promise<void> {
    unwrap(
      await this.remote.reorder(beforeId === undefined ? { projectId } : { projectId, beforeId }),
      'reorder project',
    )
  }

  /** File a Session under a project, replacing any previous assignment. */
  async assign(sessionId: SessionId, projectId: string): Promise<void> {
    await this.place(sessionId, projectId)
  }

  /** Return a Session to Ungrouped. */
  async unassign(sessionId: SessionId): Promise<void> {
    await this.place(sessionId, undefined)
  }

  /**
   * Replace the assignment map, invalidate the derived grouping, and notify.
   *
   * Clearing `derived` is not optional the way it is for the other optimistic
   * setters: the sidebar's groups are **derived from this map** and the derived
   * snapshot is cached by identity (`groupingSnapshot`), so an assignment written
   * without this would leave the row rendered under its previous owner, with no
   * error anywhere to say so.
   * @param assignments - the complete map to store.
   */
  private applyAssignments(assignments: Readonly<Record<string, string>>): void {
    this.state = Object.freeze({ ...this.state, assignments: Object.freeze(assignments) })
    this.derived = undefined
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * One entry replaced, every other entry preserved.
   *
   * `delete` rather than assigning `undefined`: absence is what Ungrouped *means*,
   * and both `sameAssignments` and `groupingSnapshot` walk `Object.keys`, so a
   * present key holding `undefined` would count as an owner.
   * @param assignments - the map to copy.
   * @param sessionId - the Session to place.
   * @param projectId - the owner, or `undefined` for Ungrouped.
   * @returns the new map.
   */
  private withPlacement(
    assignments: Readonly<Record<string, string>>,
    sessionId: SessionId,
    projectId: string | undefined,
  ): Record<string, string> {
    const next: Record<string, string> = { ...assignments }
    if (projectId === undefined) delete next[sessionId]
    else next[sessionId] = projectId
    return next
  }

  /**
   * File a Session under a project, or return it to Ungrouped, optimistically.
   *
   * Optimistic because the sidebar renders this map directly. When a New Session
   * is clicked into a project, its row is created holding whatever assignment the
   * reused blank Session already carried — so a write that waits for the Host
   * renders that row under the project it is *leaving*, and only then glides to
   * the one it is joining. That is exactly why one project's ＋ faded while
   * another project's ＋ moved: the two differ solely in whether the owner
   * changed.
   *
   * The Host stays authoritative: `follow` replaces this state wholesale, so a
   * refusal is corrected rather than left wrong.
   * @param sessionId - the Session to file.
   * @param projectId - the owning project, or `undefined` for Ungrouped.
   */
  private async place(sessionId: SessionId, projectId: string | undefined): Promise<void> {
    // `Record<string, string>` types an absent key as `string`, but absence is a
    // real state here — it is what Ungrouped means.
    const before = this.state.assignments[sessionId] as string | undefined
    // Already there. Returning early is what keeps "the same project's ＋" a fade:
    // no state change, no notification, so the row's key is new in the next commit
    // and `AnimatedRows` fades it instead of gliding it.
    if (before === projectId) return

    const token = ++this.placementSeq
    this.pendingPlacements.set(sessionId, { projectId, token })
    this.applyAssignments(this.withPlacement(this.state.assignments, sessionId, projectId))
    try {
      const outcome = projectId === undefined
        ? await this.remote.unassign({ sessionId })
        : await this.remote.assign({ sessionId, projectId })
      // Unwrapped by hand rather than through `unwrap`, which throws before the
      // rollback below could run.
      if (!outcome.ok) throw new Error(outcome.error?.message ?? 'place session failed')
    } catch (error: unknown) {
      // Only revert when this write has not already been superseded. Reverting
      // against the *current* map rather than a whole-map snapshot is deliberate:
      // the unit of this write is one Session, so a rollback must not discard a
      // concurrent placement of a different one.
      if (this.pendingPlacements.get(sessionId)?.token !== token) throw error
      this.pendingPlacements.delete(sessionId)
      this.applyAssignments(this.withPlacement(this.state.assignments, sessionId, before))
      throw error
    }
  }

  /**
   * Record whether one project row is open.
   *
   * Optimistic: the local map moves first so a click lands in the same frame, and
   * the Host is still authoritative — `follow` re-projects on every landed write,
   * so a refusal is corrected by the next frame rather than left wrong. The
   * rejection is rethrown so a caller that wants to surface it can, and the
   * revert happens regardless.
   * @param projectId - target project.
   * @param expanded - new state.
   */
  async setExpanded(projectId: string, expanded: boolean): Promise<void> {
    const previous = this.state.expansions
    if (previous[projectId] === expanded) return
    this.state = Object.freeze({ ...this.state, expansions: Object.freeze({ ...previous, [projectId]: expanded }) })
    for (const listener of [...this.listeners]) listener()
    try {
      unwrap(await this.remote.setExpanded({ projectId, expanded }), 'set project expansion')
    } catch (error: unknown) {
      // Only revert when the Host has not already answered with something newer:
      // a frame that arrived meanwhile is more current than this rollback.
      if (this.state.expansions[projectId] === expanded) {
        this.state = Object.freeze({ ...this.state, expansions: previous })
        for (const listener of [...this.listeners]) listener()
      }
      throw error
    }
  }

  /**
   * Replace the manual order of every project.
   *
   * Optimistic like {@link setExpanded}, and for the same reason: a drop has to
   * land in the frame the pointer is released in, or the row visibly springs back
   * before the Host's frame arrives. The Host stays authoritative — its `follow`
   * frame replaces this state wholesale — so a refusal is corrected rather than
   * left wrong.
   *
   * A project omitted from `orders` loses its record, which is how recency mode
   * discards manual order.
   * @param orders - the complete map to store.
   */
  async setOrders(orders: Readonly<Record<string, readonly string[]>>): Promise<void> {
    const previous = this.state.orders
    const next = Object.freeze(Object.fromEntries(
      Object.entries(orders).map(([projectId, sessionIds]) => [projectId, Object.freeze([...sessionIds])]),
    ))
    if (sameOrders(previous, next)) return
    this.state = Object.freeze({ ...this.state, orders: next })
    for (const listener of [...this.listeners]) listener()
    try {
      unwrap(await this.remote.setOrders({ orders: next }), 'set project orders')
    } catch (error: unknown) {
      // Only revert when the Host has not already answered with something newer:
      // a frame that arrived meanwhile is more current than this rollback.
      if (sameOrders(this.state.orders, next)) {
        this.state = Object.freeze({ ...this.state, orders: previous })
        for (const listener of [...this.listeners]) listener()
      }
      throw error
    }
  }

  /**
   * Choose where a New Session with no stated destination lands.
   *
   * Optimistic like {@link setExpanded}, and for the same reason: the settings
   * card should reflect the choice in the frame it is clicked in. The Host stays
   * authoritative — its `follow` frame replaces this state wholesale — so a
   * refusal is corrected rather than left wrong.
   * @param target - the chosen destination.
   */
  async setNewSessionTarget(target: NewSessionTarget): Promise<void> {
    const previous = this.state.newSessionTarget
    if (previous === target) return
    this.state = Object.freeze({ ...this.state, newSessionTarget: target })
    for (const listener of [...this.listeners]) listener()
    try {
      unwrap(await this.remote.setNewSessionTarget({ target }), 'set new session target')
    } catch (error: unknown) {
      // Only revert when the Host has not already answered with something newer.
      if (this.state.newSessionTarget === target) {
        this.state = Object.freeze({ ...this.state, newSessionTarget: previous })
        for (const listener of [...this.listeners]) listener()
      }
      throw error
    }
  }

  /**
   * Persist whether creating a project opens a Session.
   *
   * Optimistic like {@link setNewSessionTarget}, and for the same reason: the switch
   * has to follow the click in the frame it happened, or it springs back before the
   * Host's frame arrives.
   * @param value - the chosen behaviour.
   */
  async setCreateOpensSession(value: boolean): Promise<void> {
    const previous = this.state.createOpensSession
    if (previous === value) return
    this.state = Object.freeze({ ...this.state, createOpensSession: value })
    for (const listener of [...this.listeners]) listener()
    try {
      unwrap(await this.remote.setCreateOpensSession({ value }), 'set create-opens-session')
    } catch (error: unknown) {
      // Only revert when the Host has not already answered with something newer.
      if (this.state.createOpensSession === value) {
        this.state = Object.freeze({ ...this.state, createOpensSession: previous })
        for (const listener of [...this.listeners]) listener()
      }
      throw error
    }
  }

  /**
   * Store the base workspace: the Workspace every New Session lands in.
   *
   * Optimistic like {@link setNewSessionTarget}, and for the same reason: the card
   * should show the chosen card as selected in the frame it is confirmed in. The Host
   * stays authoritative — its `follow` frame replaces this state wholesale — so a
   * refusal is corrected rather than left wrong.
   * @param setting - the chosen mode and, for `'specified'`, the Workspace.
   */
  async setBaseWorkspace(setting: BaseWorkspaceSetting): Promise<void> {
    const previous = this.state.baseWorkspace
    // Normalise **before** comparing, so the rule the Host applies on commit is the one
    // this frame renders. Skipping this is what made the card flash 「未选择」: a
    // `{ mode: 'default' }` written optimistically carried no `path` while the stored value
    // did, and the Host's frame put it back one animation frame later.
    //
    // It also repairs the no-op guard for free: `{ mode: 'default' }` could never equal a
    // stored `{ mode: 'default', path, name }`, so re-clicking the already-selected 默认
    // card issued a redundant write (measured: one round trip per click).
    const next = setting.mode === 'default' ? withDefaultMode(previous) : setting
    if (sameBaseWorkspace(previous, next)) return
    this.state = Object.freeze({ ...this.state, baseWorkspace: Object.freeze({ ...next }) })
    for (const listener of [...this.listeners]) listener()
    try {
      unwrap(await this.remote.setBaseWorkspace({ ...next }), 'set base workspace')
    } catch (error: unknown) {
      // Only revert when the Host has not already answered with something newer.
      //
      // Compared against `next`, not `setting`: the question is "is the normalised value
      // still on screen", and a raw `{ mode: 'default' }` never equals it, which would
      // make this branch dead and leave a refused write uncorrected.
      if (sameBaseWorkspace(this.state.baseWorkspace, next)) {
        this.state = Object.freeze({ ...this.state, baseWorkspace: previous })
        for (const listener of [...this.listeners]) listener()
      }
      throw error
    }
  }

  /**
   * Re-create the base Workspace on the Host.
   *
   * Deliberately **not** optimistic, unlike every other write in this class. The others change
   * state the user is already looking at, where a slow round trip reads as lag; this one creates a
   * directory and a registry row, and a failure has to reach the dialog rather than be painted
   * over. The resulting state arrives over `follow` like any other Host change.
   * @returns the repaired Workspace and the setting's mode afterwards.
   */
  async rebuildBaseWorkspace(): Promise<ProjectRebuildBaseWorkspaceValue> {
    return unwrap(
      await this.remote.rebuildBaseWorkspace(),
      'rebuild the base workspace',
    ) as ProjectRebuildBaseWorkspaceValue
  }

  /**
   * Ask the Host where the official default Workspace would live.
   *
   * A pure read, used only to label the missing-基层工作区 dialog. A failure is not
   * propagated: the dialog already renders "path unknown", and turning a label into
   * a thrown error out of a click handler would be worse than the label.
   * @returns the derived path, or null when the Host cannot produce one.
   */
  async defaultWorkspacePath(): Promise<string | null> {
    try {
      const value = unwrap(await this.remote.defaultWorkspacePath(), 'derive the default workspace path')
      return (value as { path: string | null }).path ?? null
    } catch {
      return null
    }
  }

  private acceptFrame(frame: ProjectFollowFrame): void {
    if (frame.type === 'baseline') {
      this.accept(frame.value)
      return
    }
    // Increments are not used: the Host re-projects as a baseline on every
    // change, so only that branch is reachable today. Kept exhaustive so a
    // future increment fails loudly here rather than being dropped.
    console.warn('project frame ignored:', frame.type)
  }

  private accept(baseline: ProjectBaseline): void {
    const projects = Object.freeze(baseline.projects.map(project => Object.freeze({ ...project })))
    // Retire every placement the Host has now echoed: this frame carries our
    // value, so the local guess and the authoritative one agree and the overlay
    // has done its job.
    for (const [sessionId, entry] of this.pendingPlacements) {
      if ((baseline.assignments[sessionId] as string | undefined) === entry.projectId) {
        this.pendingPlacements.delete(sessionId)
      }
    }
    // Overlay what is still in flight. A frame produced before our write carries
    // the previous owner; accepting it would revert the row for one render and
    // bring back exactly the move the optimistic write removes.
    const overlaid: Record<string, string> = { ...baseline.assignments }
    for (const [sessionId, entry] of this.pendingPlacements) {
      if (entry.projectId === undefined) delete overlaid[sessionId]
      else overlaid[sessionId] = entry.projectId
    }
    const assignments = Object.freeze(overlaid)
    const expansions = Object.freeze({ ...baseline.expansions ?? {} })
    // Read through `?? {}` rather than assuming the field: a baseline missing it
    // degrades to "no manual order" (members fall back to recency) instead of
    // throwing inside the sidebar's render path. Both halves ship together, so
    // this is not a normal state — it is the difference between a wrong order and
    // a dead sidebar.
    const orders = Object.freeze(Object.fromEntries(
      Object.entries(baseline.orders ?? {})
        .map(([projectId, sessionIds]) => [projectId, Object.freeze([...sessionIds])]),
    ))
    // Compare by value: the Host re-projects on every change, and a frame that
    // carries the same state must not invalidate the snapshot the browser
    // compares by identity.
    //
    // `newSessionTarget` reads through a default for the same reason `orders`
    // reads through `?? {}`: a Host that predates the field degrades to the
    // shipped behaviour rather than throwing in the sidebar's render path.
    const newSessionTarget = baseline.newSessionTarget ?? 'ungrouped'
    // Same guard for the base-workspace setting: a Host predating the field means
    // "the official default Workspace", which is what it already did.
    const baseWorkspace = baseline.baseWorkspace ?? { mode: 'default' as const }
    // And the same for this one: a Host predating the field did not open a Session on
    // create, so the value it actually behaves as is the official add-workspace
    // behaviour — on. Reading through a default keeps the switch honest against an
    // older Host instead of showing "off" for behaviour that is on.
    const createOpensSession = baseline.createOpensSession ?? true
    if (
      sameProjects(this.state.projects, projects)
      && sameAssignments(this.state.assignments, assignments)
      && sameExpansions(this.state.expansions, expansions)
      && sameOrders(this.state.orders, orders)
      && this.state.newSessionTarget === newSessionTarget
      && this.state.createOpensSession === createOpensSession
      && sameBaseWorkspace(this.state.baseWorkspace, baseWorkspace)
    ) {
      return
    }
    this.state = Object.freeze({
      projects, assignments, expansions, orders, newSessionTarget, createOpensSession, baseWorkspace,
    })
    this.derived = undefined
    for (const listener of [...this.listeners]) listener()
  }

  private groupingSnapshot(): readonly GroupSource[] {
    this.derived ??= Object.freeze(this.state.projects.map(project => Object.freeze({
      key: project.projectId,
      label: project.title,
      // Members come from the assignment map, so a Session appears under the
      // project the Host says owns it. A stale id (a deleted Session) is absent
      // from the browser's list and therefore simply not rendered.
      sessionIds: Object.freeze(
        Object.entries(this.state.assignments)
          .filter(([, projectId]) => projectId === project.projectId)
          .map(([sessionId]) => sessionId as SessionId),
      ),
      // Marks the row as ours: the region gives it a rename/delete menu and a
      // reorder drag target, driven through this model rather than the registry.
      kind: 'project',
    } satisfies GroupSource)))
    return this.derived
  }
}

/** Value equality over the project rows. */
function sameProjects(left: readonly ProjectValue[], right: readonly ProjectValue[]): boolean {
  if (left.length !== right.length) return false
  return left.every((project, index) => {
    const other = right[index]
    return other !== undefined
      && project.projectId === other.projectId
      && project.title === other.title
      && project.docPath === other.docPath
      && project.updatedAt === other.updatedAt
  })
}

/** Value equality over the assignment map. */
function sameAssignments(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(key => left[key] === right[key])
}

/**
 * Value equality over the expansion map.
 *
 * An absent key and a `false` value are different states, so the comparison is
 * over entries rather than over a defaulted value: folding a row the user had
 * never touched is a real change and must notify.
 */
function sameExpansions(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(key => left[key] === right[key])
}

/**
 * Value equality over the order map.
 *
 * Order is the whole point of the value, so the comparison is positional: a
 * reordered project differs even though it holds the same members.
 */
function sameOrders(
  left: Readonly<Record<string, readonly string[]>>,
  right: Readonly<Record<string, readonly string[]>>,
): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => {
    const a = left[key]
    const b = right[key]
    if (b === undefined || a === undefined || a.length !== b.length) return false
    return a.every((id, index) => id === b[index])
  })
}
