/**
 * Host half of dsh-project-groups.
 *
 * Owns the durable project table and serves it over the plugin's own Remote
 * namespace. Everything the sidebar shows about projects comes from here; the
 * Host's workspace registry is never written, so a Session's `cwd` and its
 * official Workspace account are exactly what they were before this plugin was
 * installed.
 *
 * ## Why no generated Typert artifact
 *
 * The official Remote owners ship a `typert.remote-client.js` produced by
 * `@deepseek-ai/dsh-typert-generator`. That generator is built for the harness
 * monorepo: it discovers packages only under `<root>/packages` (or `vendor`) and
 * requires a `tsconfig.host.json` at the workspace root, so an out-of-tree
 * plugin cannot use it without masquerading as a monorepo.
 *
 * It is not needed here. The Gateway has an SRC fallback
 * (`packages/api/gateway/src/index.ts`, `resolveSrcDescriptor`) that derives an
 * invocation descriptor at runtime from the service's `typertRemote` binding
 * plus the `@Remote` markers its prototype carries — and `TypertRemoteService`
 * is what supplies that binding. So `@Remote` is sufficient on this side, and
 * the Client ships hand-written descriptors instead of generated ones
 * (`src/client/remote.ts`).
 */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain, DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { PROJECT_DOMAIN_NAME, projectDomainSpec, type BaseWorkspaceSetting, type GlobalRecord, type ProjectRecord } from './spec.ts'
import { defaultWorkspacePath as deriveDefaultWorkspacePath } from './default-workspace.ts'
import {
  PROJECT_NAMESPACE, PROJECT_SERVICE_KEY,
  type ProjectAssignRequest, type ProjectAssignmentValue, type ProjectBaseline,
  type ProjectBaseWorkspaceValue,
  type ProjectCreateRequest, type ProjectDeleteRequest, type ProjectExpansionValue,
  type ProjectFollowFrame, type ProjectOrderValue, type ProjectOrdersValue,
  type ProjectNewSessionTargetValue,
  type ProjectRenameRequest, type ProjectRenameValue, type ProjectReorderRequest,
  type ProjectSetBaseWorkspaceRequest,
  type ProjectSetExpandedRequest, type ProjectSetNewSessionTargetRequest, type ProjectSetOrdersRequest,
  type ProjectUnassignRequest, type ProjectUnassignValue,
  type ProjectValue, type ProjectValueResult,
  type ProjectDefaultWorkspacePathValue,
} from './protocol.ts'

/**
 * Required Host services. The storage domain facility opens this plugin's
 * domain; without it there is nowhere durable to put a project.
 */
export const inject = ['storageDomain']

/**
 * Host project registry: the durable table, its order, and the assignment map,
 * plus the Remote methods the Client calls.
 *
 * Extends `TypertRemoteService` rather than plain `Service`: that base's
 * constructor installs the `typertRemote` binding the Gateway's SRC discovery
 * reads, and without it none of the `@Remote` markers below would be reachable.
 *
 * Reads are synchronous from the domain's in-memory state; every write queues on
 * the domain's own chain, so a rejected durable write leaves memory untouched.
 */
export class ProjectController extends TypertRemoteService {
  static inject = ['storageDomain']

  private domain: Domain<typeof projectDomainSpec> | undefined
  /** Live followers, each woken by a landed write. */
  private readonly followers = new Set<() => void>()
  /** Serializes domain opens so repeated activation cannot open twice. */
  private opening: Promise<void> | undefined
  /** Listener for `domain/changed`, held so the close path can drop it. */
  private detach: (() => void) | undefined

  /**
   * @param ctx - Host context carrying the storage-domain facility.
   */
  constructor(ctx: Context) {
    super(ctx, PROJECT_SERVICE_KEY, { namespace: PROJECT_NAMESPACE })
    ctx.effect(() => () => this.close(), 'project-groups: domain close')
  }

  /**
   * Open this plugin's domain once, on first use.
   *
   * Deferred rather than done in the constructor because `open` is async and a
   * Service constructor is not; a composition that never touches projects pays
   * nothing for it.
   * @returns the open domain.
   */
  private async ready(): Promise<Domain<typeof projectDomainSpec>> {
    this.opening ??= (async () => {
      this.domain = await this.ctx.storageDomain.open(projectDomainSpec)
      this.detach = this.ctx.on('domain/changed', (change) => {
        if (change.domain !== PROJECT_DOMAIN_NAME) return
        for (const wake of [...this.followers]) wake()
      })
    })()
    await this.opening
    /* v8 ignore next -- the open assigned `domain`, or it threw and this line is unreachable. */
    return this.domain as Domain<typeof projectDomainSpec>
  }

  private async close(): Promise<void> {
    const domain = this.domain
    this.detach?.()
    this.detach = undefined
    this.domain = undefined
    this.opening = undefined
    this.followers.clear()
    if (domain !== undefined) await domain.close()
  }

  /** Current display order; empty before the first order write. */
  private order(): readonly string[] {
    return this.domain?.global.get().projectIds ?? []
  }

  /**
   * Write the global singleton, changing only the fields given.
   *
   * `Domain.global.set` replaces the whole value rather than merging into it, so
   * every writer must spread what is already stored. Routing them all through
   * here means a writer cannot drop a field it does not know about — which is
   * exactly what the type checker caught when `newSessionTarget` was added to a
   * singleton three existing call sites were writing whole.
   * @param domain - the open domain.
   * @param patch - the fields to change.
   */
  private async setGlobal(
    domain: Domain<typeof projectDomainSpec>,
    patch: Partial<GlobalRecord>,
  ): Promise<void> {
    await domain.global.set({ ...domain.global.get(), ...patch })
  }

  private projectValue(projectId: string, record: ProjectRecord): ProjectValue {
    return {
      projectId,
      title: record.title,
      docPath: record.docPath,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /**
   * The complete Client projection: projects in display order, the order itself,
   * and every assignment.
   * @returns the baseline a following generation opens with.
   */
  @Remote('baseline')
  async baseline(): Promise<ProjectBaseline> {
    const domain = await this.ready()
    const projects = domain.table('projects')
    const assignments = domain.table('assignments')
    // The order array is authoritative, but a record that landed without an
    // order entry (an interrupted write, or a hand-edited medium) must still be
    // visible rather than silently dropped.
    const ordered = this.order().filter(id => projects.get(id) !== undefined)
    const seen = new Set(ordered)
    for (const id of projects.keys()) if (!seen.has(id)) ordered.push(id)
    return {
      projects: ordered.map(id => this.projectValue(id, projects.get(id) as ProjectRecord)),
      projectIds: ordered,
      assignments: Object.fromEntries(
        [...assignments.entries()].map(([sessionId, record]) => [sessionId, record.projectId]),
      ),
      // Only recorded rows appear: an absent entry means "never touched", which
      // the browser needs to distinguish from an explicit `false`.
      expansions: Object.fromEntries(
        [...domain.table('expansions').entries()].map(([projectId, record]) => [projectId, record.expanded]),
      ),
      // Likewise only recorded rows: an absent project has no manual order, so
      // the browser derives member position from recency.
      orders: Object.fromEntries(
        [...domain.table('orders').entries()].map(([projectId, record]) => [projectId, [...record.sessionIds]]),
      ),
      // The stored global is parsed through the spec's schema on open, so a unit
      // written before this field existed already reads back as its default.
      newSessionTarget: domain.global.get().newSessionTarget,
      baseWorkspace: domain.global.get().baseWorkspace,
    }
  }

  /**
   * Create a project, at the **front** of the display order.
   *
   * Prepend rather than append, matching the Host's own Workspace registry
   * (`packages/workspace/workspace/src/index.ts`: `workspaceIds: [id,
   * ...state.workspaceIds]`). A new row appears where the user is looking instead
   * of below however many rows already exist, which is what makes a long list
   * workable.
   * @param request - display title; surrounding whitespace is trimmed.
   * @returns the created project.
   */
  @Remote('create')
  async create(request: ProjectCreateRequest): Promise<ProjectValueResult> {
    const title = request.title.trim()
    if (title === '') throw new Error('a project title is required')
    const domain = await this.ready()
    const projectId = newProjectId()
    const now = new Date().toISOString()
    const record: ProjectRecord = { title, docPath: '', createdAt: now, updatedAt: now }
    await domain.table('projects').put(projectId, record)
    await this.setGlobal(domain, { projectIds: [projectId, ...this.order()] })
    return { project: this.projectValue(projectId, record) }
  }

  /**
   * Retitle one project.
   * @param request - target project and its new title.
   * @returns the updated project.
   */
  @Remote('rename')
  async rename(request: ProjectRenameRequest): Promise<ProjectRenameValue> {
    const title = request.title.trim()
    if (title === '') throw new Error('a project title is required')
    const domain = await this.ready()
    const record = domain.table('projects').get(request.projectId)
    if (record === undefined) throw new Error(`unknown project: ${request.projectId}`)
    const next: ProjectRecord = { ...record, title, updatedAt: new Date().toISOString() }
    await domain.table('projects').put(request.projectId, next)
    return { project: this.projectValue(request.projectId, next) }
  }

  /**
   * Remove one project, every assignment onto it, and its presentation records.
   *
   * Sessions are not touched: an assignment is this plugin's own record, and a
   * Session without one is simply Ungrouped. The expansion and order go with the
   * project because both are keyed by project id and would otherwise be
   * unreachable state.
   * @param request - target project.
   */
  @Remote('delete')
  async remove(request: ProjectDeleteRequest): Promise<void> {
    const domain = await this.ready()
    for (const [sessionId, record] of [...domain.table('assignments').entries()]) {
      if (record.projectId === request.projectId) await domain.table('assignments').delete(sessionId)
    }
    await domain.table('projects').delete(request.projectId)
    await domain.table('expansions').delete(request.projectId)
    await domain.table('orders').delete(request.projectId)
    await this.setGlobal(domain, { projectIds: this.order().filter(id => id !== request.projectId) })
  }

  /**
   * Move one project in display order.
   * @param request - project to move and the project it should precede.
   * @returns the new order.
   */
  @Remote('reorder')
  async reorder(request: ProjectReorderRequest): Promise<ProjectOrderValue> {
    const domain = await this.ready()
    const current = [...this.order()]
    if (!current.includes(request.projectId)) throw new Error(`unknown project: ${request.projectId}`)
    const rest = current.filter(id => id !== request.projectId)
    const index = request.beforeId === undefined ? rest.length : rest.indexOf(request.beforeId)
    if (index === -1) throw new Error(`unknown project: ${String(request.beforeId)}`)
    const projectIds = [...rest.slice(0, index), request.projectId, ...rest.slice(index)]
    await this.setGlobal(domain, { projectIds })
    return { projectIds }
  }

  /**
   * File one Session under one project, replacing any previous assignment.
   * @param request - Session and target project.
   * @returns the landed assignment.
   */
  @Remote('assign')
  async assign(request: ProjectAssignRequest): Promise<ProjectAssignmentValue> {
    const domain = await this.ready()
    if (domain.table('projects').get(request.projectId) === undefined) {
      throw new Error(`unknown project: ${request.projectId}`)
    }
    await domain.table('assignments').put(request.sessionId, {
      projectId: request.projectId,
      assignedAt: new Date().toISOString(),
    })
    return { sessionId: request.sessionId, projectId: request.projectId }
  }

  /**
   * Return one Session to Ungrouped.
   * @param request - Session to unassign.
   * @returns whether an assignment was removed.
   */
  @Remote('unassign')
  async unassign(request: ProjectUnassignRequest): Promise<ProjectUnassignValue> {
    const domain = await this.ready()
    const removed = await domain.table('assignments').delete(request.sessionId)
    return { sessionId: request.sessionId, removed }
  }

  /**
   * Record one project row's open/closed state.
   *
   * Stored here rather than in the browser's view store because that store is
   * shared with the official plugin, whose mount prunes every key that is not a
   * Workspace id — so a project's expansion kept there is lost the first time the
   * official sidebar mounts, which is precisely what switching this plugin off
   * does.
   *
   * A write is always recorded, `false` included: "folded deliberately" and
   * "never touched" must stay distinguishable, since only the latter lets the
   * browser open the group holding the current Session.
   * @param request - target project and its new state.
   * @returns the recorded state.
   */
  @Remote('setExpanded')
  async setExpanded(request: ProjectSetExpandedRequest): Promise<ProjectExpansionValue> {
    const domain = await this.ready()
    if (domain.table('projects').get(request.projectId) === undefined) {
      throw new Error(`unknown project: ${request.projectId}`)
    }
    await domain.table('expansions').put(request.projectId, { expanded: request.expanded })
    return { projectId: request.projectId, expanded: request.expanded }
  }

  /**
   * Replace the manual order of every project.
   *
   * Whole-map, because the callers need exactly that: a drop rewrites the target
   * project and freezes the rest, switching to manual freezes all of them, and
   * switching to recency discards them all. A project absent from the request has
   * its record **deleted** — that is what makes recency mode mean "no manual
   * order" rather than "a stale one".
   *
   * Writes are diffed against what is stored. Every landed write makes the
   * follower re-project, so skipping unchanged projects keeps a frame's cost
   * proportional to the real change rather than to the number of projects.
   *
   * Unknown project ids are dropped, not refused: they can only come from a race
   * with a delete, and refusing would turn that race into a lost drag.
   * @param request - the complete order map to store.
   * @returns the map the Host actually holds.
   */
  @Remote('setOrders')
  async setOrders(request: ProjectSetOrdersRequest): Promise<ProjectOrdersValue> {
    const domain = await this.ready()
    const projects = domain.table('projects')
    const orders = domain.table('orders')
    const next = Object.fromEntries(
      Object.entries(request.orders)
        .filter(([projectId]) => projects.get(projectId) !== undefined)
        .map(([projectId, sessionIds]) => [projectId, [...sessionIds]]),
    )
    for (const projectId of [...orders.keys()]) {
      if (next[projectId] === undefined) await orders.delete(projectId)
    }
    for (const [projectId, sessionIds] of Object.entries(next)) {
      const stored = orders.get(projectId)?.sessionIds
      const unchanged = stored !== undefined && stored.length === sessionIds.length
        && stored.every((id, index) => id === sessionIds[index])
      if (!unchanged) await orders.put(projectId, { sessionIds })
    }
    return { orders: next }
  }

  /**
   * Choose where a New Session with no stated destination lands.
   *
   * The stored global is spread before the write because `Domain.global.set`
   * replaces the whole singleton rather than merging into it: sending only the
   * target would drop `projectIds` and make every project disappear from the
   * sidebar.
   * @param request - the chosen destination.
   * @returns the stored choice.
   */
  @Remote('setNewSessionTarget')
  async setNewSessionTarget(
    request: ProjectSetNewSessionTargetRequest,
  ): Promise<ProjectNewSessionTargetValue> {
    const domain = await this.ready()
    await this.setGlobal(domain, { newSessionTarget: request.target })
    return { target: request.target }
  }

  /**
   * Choose the Workspace every New Session this plugin opens lands in.
   *
   * ## `path`/`name` are a **memory**, not part of the mode
   *
   * Switching to `'default'` **keeps** the stored `path` and `name`. They record which
   * Workspace the user last picked, so switching 默认 → 指定 restores that choice instead
   * of forcing them to pick again. Clearing them — which this did at first — made the
   * setting look like it could not be remembered at all, which is exactly how it was
   * reported.
   *
   * Every reader gates on `mode`, so a retained path cannot be mistaken for an active
   * one: the card's "已不存在" note only fires in `'specified'`, and the resolver branches
   * on `mode` too.
   *
   * A `'specified'` write without a path is still refused: it would be a setting that can
   * never resolve, which is the very failure this feature reports.
   *
   * The write goes through {@link setGlobal}, which spreads the stored singleton —
   * writing it whole would drop `projectIds` and empty the sidebar.
   * @param request - the chosen mode and, for `'specified'`, the Workspace.
   * @returns the setting as stored, including the retained memory for `'default'`.
   */
  @Remote('setBaseWorkspace')
  async setBaseWorkspace(request: ProjectSetBaseWorkspaceRequest): Promise<ProjectBaseWorkspaceValue> {
    const domain = await this.ready()
    if (request.mode === 'specified' && (request.path ?? '') === '') {
      throw new Error('a specified base workspace needs a path')
    }
    const stored = domain.global.get().baseWorkspace
    const next: BaseWorkspaceSetting = request.mode === 'default'
      // Retained, not cleared: see the note above.
      ? { mode: 'default', path: stored?.path, name: stored?.name }
      : { mode: 'specified', path: request.path, name: request.name ?? '' }
    await this.setGlobal(domain, { baseWorkspace: next })
    return next
  }

  /**
   * Report where the official default Workspace would live.
   *
   * The missing-底层工作区 dialog names the path that is gone, and no Client-side
   * caller can produce it: the derivation starts at the OS Documents folder, which
   * only this half can query (`src/default-workspace.ts` explains why the official
   * helper is reimplemented rather than imported).
   *
   * A pure read — nothing is created or registered — and `path: null` when the
   * Documents folder is unreadable, so the dialog can say "unknown" instead of
   * showing a path it did not verify.
   * @returns the derived path, or `null`.
   */
  @Remote('defaultWorkspacePath')
  async defaultWorkspacePath(): Promise<ProjectDefaultWorkspacePathValue> {
    return { path: await deriveDefaultWorkspacePath() }
  }

  /**
   * Stream the projection: a baseline first, then a fresh baseline per landed
   * write.
   *
   * Every frame is a complete projection rather than a diff. That is what makes
   * reconnection trivial (a new generation opens with a baseline and the Client
   * replaces its state) and what keeps the two sides from having to agree on
   * increment semantics. The writes here are user gestures, not a hot path, so
   * re-projecting costs nothing that matters.
   * @param signal - caller lifetime; the follower leaves with it.
   * @returns the frame stream.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<ProjectFollowFrame> {
    // Baseline before subscribing: attaching a listener first could let a
    // concurrent write land between the two, and its frame would then arrive
    // before the baseline that already contains it.
    const frames: ProjectFollowFrame[] = []
    let wake: (() => void) | undefined
    const push = (): void => {
      const pending = wake
      wake = undefined
      pending?.()
    }
    const refresh = async (): Promise<void> => {
      frames.push({ type: 'baseline', value: await this.baseline() })
      push()
    }
    yield { type: 'baseline', value: await this.baseline() }

    await this.ready()
    const onChanged = (): void => { void refresh() }
    this.followers.add(onChanged)
    const leave = (): void => { this.followers.delete(onChanged) }
    signal.addEventListener('abort', leave, { once: true })
    try {
      while (!signal.aborted) {
        const next = frames.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      leave()
      signal.removeEventListener('abort', leave)
    }
  }
}

/**
 * A fresh project id.
 *
 * `randomUUID` is present on every supported Node line; the fallback keeps an
 * exotic runtime working rather than throwing during a create.
 * @returns a unique id.
 */
function newProjectId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (random !== undefined) return random
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Mount the Host half.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  new ProjectController(ctx)
}

/** Re-exported so the Client contribution and Host agree on one declaration. */
export type { DomainChanged }
