/**
 * The project model this plugin's sidebar is a view of.
 *
 * ## Where the data lives
 *
 * The Host owns it: `src/index.ts` keeps the durable table under
 * `$DSH_HOME/storages/`, and this class mirrors the projection it streams. Every
 * verb here calls the Remote method and lets the resulting `follow` frame update
 * the state — nothing is applied optimistically, so the sidebar can never show a
 * project the Host did not accept.
 *
 * ## Why the grouping observable caches its snapshot
 *
 * The vendored browser's selector compares snapshot identity, so a fresh array
 * per read would re-render every consumer on each store ping. The derived
 * `GroupSource[]` is therefore rebuilt only when the projection actually
 * changes, which is the same discipline the shipped `derive()` helper enforces.
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
import type { ProjectBaseline, ProjectFollowFrame, ProjectValue, NewSessionTarget } from '../protocol.ts'

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
}

const EMPTY_STATE: ProjectState = Object.freeze({
  projects: Object.freeze([]),
  assignments: Object.freeze({}),
  expansions: Object.freeze({}),
  orders: Object.freeze({}),
  newSessionTarget: 'ungrouped',
})

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

  /** Create a project; the state updates when the Host's write reaches the stream. */
  async create(title: string): Promise<void> {
    unwrap(await this.remote.create({ title: title.trim() }), 'create project')
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
    unwrap(await this.remote.assign({ sessionId, projectId }), 'assign session')
  }

  /** Return a Session to Ungrouped. */
  async unassign(sessionId: SessionId): Promise<void> {
    unwrap(await this.remote.unassign({ sessionId }), 'unassign session')
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
    const assignments = Object.freeze({ ...baseline.assignments })
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
    if (
      sameProjects(this.state.projects, projects)
      && sameAssignments(this.state.assignments, assignments)
      && sameExpansions(this.state.expansions, expansions)
      && sameOrders(this.state.orders, orders)
      && this.state.newSessionTarget === newSessionTarget
    ) {
      return
    }
    this.state = Object.freeze({ projects, assignments, expansions, orders, newSessionTarget })
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
