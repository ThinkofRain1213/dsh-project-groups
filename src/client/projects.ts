/**
 * The project model this plugin layers over the vendored sidebar.
 *
 * ## What a project is
 *
 * A title plus a set of Sessions. It is **not** a Workspace: it owns no
 * directory, contributes nothing to the Host registry, and never touches a
 * Session's `cwd`. Every Session stays in the Host's default Workspace; the
 * project is the grouping the sidebar draws on top.
 *
 * ## Why it lives here and not in the Host
 *
 * L1-1 stages the model in the browser so the sidebar can be exercised before
 * the persistence seam exists. `ctx.storageDomain` and the Remote namespace that
 * reach it are L1-2; the shape below is already the one those will carry, so
 * that step replaces this file's storage, not its API.
 *
 * The consequence while staged: projects do not survive a reload.
 *
 * ## Membership
 *
 * L1-1 moves no Sessions, so every project reports an empty membership and the
 * whole list renders under Ungrouped — which is the correct starting state
 * (nothing has been filed yet), not a placeholder. Assignment arrives with the
 * drag interaction in L2.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GroupSource } from '../vendored/client/tree.ts'

/** One project as the sidebar renders it. */
export interface Project {
  readonly id: string
  readonly title: string
}

/** Sessions filed under one project. L2 fills this; L1-1 always reads it empty. */
const NO_MEMBERS: readonly SessionId[] = Object.freeze([])

/**
 * Stable project identity. `randomUUID` is available in every secure context,
 * which includes the loopback URL the Web UI is served from; the fallback keeps
 * an exotic embedding (a non-secure origin) working rather than throwing.
 * @returns a fresh project id.
 */
function newProjectId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (random !== undefined) return random
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Front-end project store: the list, its derived grouping source, and the verbs
 * the sidebar drives.
 *
 * The grouping observable is what the vendored browser consumes. Its snapshot is
 * cached and only rebuilt on a real change, because the browser's selector
 * compares snapshot identity — a fresh array per read would re-render every
 * consumer on each store ping. This is the same discipline the shipped
 * `derive()` helper enforces.
 */
export class ProjectModel {
  private projects: readonly Project[] = []
  private derived: readonly GroupSource[] | undefined
  private readonly listeners = new Set<() => void>()

  /**
   * The grouping source handed to the vendored browser.
   *
   * Always an array, never `undefined`: `undefined` means "group by the Host
   * Workspace registry" (upstream), while an empty array is an active override
   * claiming nothing. An empty list is therefore the honest state for a fresh
   * install — projects exist as a feature, none has been created.
   */
  readonly grouping: HostObservable<readonly GroupSource[] | undefined> = {
    getSnapshot: () => this.groupingSnapshot(),
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /** @returns projects in display order. */
  list(): readonly Project[] {
    return this.projects
  }

  /** @returns the project with this id, or undefined. */
  get(id: string): Project | undefined {
    return this.projects.find(project => project.id === id)
  }

  /**
   * Append a project.
   * @param title - already-trimmed, non-blank display title.
   * @returns the created project.
   */
  create(title: string): Project {
    const project: Project = Object.freeze({ id: newProjectId(), title })
    this.projects = [...this.projects, project]
    this.changed()
    return project
  }

  /**
   * Retitle one project in place.
   * @param id - target project.
   * @param title - already-trimmed, non-blank display title.
   * @returns whether a project carried that id.
   */
  rename(id: string, title: string): boolean {
    if (!this.projects.some(project => project.id === id)) return false
    this.projects = this.projects.map(project => project.id === id ? { ...project, title } : project)
    this.changed()
    return true
  }

  /**
   * Remove one project. Its Sessions are not touched anywhere: membership is
   * L2's separate table, and an absent membership already reads as Ungrouped.
   * @param id - target project.
   * @returns whether a project was removed.
   */
  delete(id: string): boolean {
    const next = this.projects.filter(project => project.id !== id)
    if (next.length === this.projects.length) return false
    this.projects = next
    this.changed()
    return true
  }

  /**
   * Move one project to a position in display order.
   * @param id - project to move.
   * @param beforeId - project it should precede; absent appends to the end.
   * @returns whether the order changed.
   */
  reorder(id: string, beforeId?: string): boolean {
    const moving = this.projects.find(project => project.id === id)
    if (moving === undefined) return false
    const rest = this.projects.filter(project => project.id !== id)
    const index = beforeId === undefined ? rest.length : rest.findIndex(project => project.id === beforeId)
    if (index === -1) return false
    const next = [...rest.slice(0, index), moving, ...rest.slice(index)]
    if (next.every((project, position) => project.id === this.projects[position]?.id)) return false
    this.projects = next
    this.changed()
    return true
  }

  private groupingSnapshot(): readonly GroupSource[] {
    this.derived ??= Object.freeze(this.projects.map(project => Object.freeze({
      key: project.id,
      label: project.title,
      sessionIds: NO_MEMBERS,
      // Marks the row as ours: the region gives it a rename/delete menu and a
      // reorder drag target, and drives them through this model rather than
      // the Host registry.
      kind: 'project',
    } satisfies GroupSource)))
    return this.derived
  }

  private changed(): void {
    // Drop the cache before notifying: a listener reads the snapshot during the
    // notification and must observe the new value.
    this.derived = undefined
    for (const listener of [...this.listeners]) listener()
  }
}
