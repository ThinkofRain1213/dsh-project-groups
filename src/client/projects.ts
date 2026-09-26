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
import type { ProjectBaseline, ProjectFollowFrame, ProjectValue } from '../protocol.ts'

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
}

const EMPTY_STATE: ProjectState = Object.freeze({
  projects: Object.freeze([]),
  assignments: Object.freeze({}),
  expansions: Object.freeze({}),
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
    const expansions = Object.freeze({ ...baseline.expansions })
    // Compare by value: the Host re-projects on every change, and a frame that
    // carries the same state must not invalidate the snapshot the browser
    // compares by identity.
    if (
      sameProjects(this.state.projects, projects)
      && sameAssignments(this.state.assignments, assignments)
      && sameExpansions(this.state.expansions, expansions)
    ) {
      return
    }
    this.state = Object.freeze({ projects, assignments, expansions })
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
