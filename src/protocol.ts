/**
 * Wire vocabulary shared by the Host half and this plugin's own Client
 * contribution.
 *
 * Both halves key off the endpoint names below, so a rename here is a breaking
 * change on both sides at once rather than a silent mismatch at runtime: the
 * Client contribution's descriptors and the Host's `@Remote` exports are
 * derived from the same constants.
 *
 * The wire payloads are plain data shapes. Nothing crosses that is not JSON, which is
 * what lets both codecs be pass-throughs (see `src/client/remote.ts`). The module also
 * carries the few runtime agreements the two halves must share — the namespace constants
 * below and `withDefaultMode` — because a rule stated twice is a rule that drifts.
 */
import type { BaseWorkspaceSetting, NewSessionTarget } from './spec.ts'

export type { BaseWorkspaceMode, BaseWorkspaceSetting, NewSessionTarget } from './spec.ts'

/** The Cordis service key owning these methods, and the default wire namespace. */
export const PROJECT_SERVICE_KEY = 'projectController'

/** The Remote namespace the Client calls (`ctx.remote.projectGroups`). */
export const PROJECT_NAMESPACE = 'projectGroups'

/**
 * The setting a `'default'` write stores: switch the mode, **keep the memory**.
 *
 * `path`/`name` record which Workspace the user last picked, and switching to 默认 must
 * not discard that — otherwise switching back has nothing to restore, which is how it was
 * reported ("切回默认再回来又要重新选").
 *
 * ## Why this is a function and not two matching expressions
 *
 * The rule has to hold in **both** halves: the Host decides what to persist, and the
 * Client's optimistic write decides what to render in the frame the user clicked. It was
 * written out twice — the Host applied it, the Client did not — and the two drifted, which
 * is what made the card flash 「未选择」 for one animation frame before the Host's frame
 * corrected it. A single implementation cannot drift.
 *
 * Stated here rather than in `spec.ts` because that module imports `zod` as a **value** and
 * therefore cannot be reached from the browser bundle. This module is already the two
 * halves' shared vocabulary (see the constants above), so the rule belongs with them.
 *
 * Note that the `'specified'` direction is deliberately **not** mirrored here: it is
 * genuinely asymmetric — a `name` that arrives absent is cleared, where `'default'` retains
 * one — and forcing the two through one shape would erase that difference.
 * @param stored - the setting as it stands, or `undefined` before any write.
 * @returns the `'default'` setting, carrying the remembered Workspace through.
 */
export function withDefaultMode(stored: BaseWorkspaceSetting | undefined): BaseWorkspaceSetting {
  return { mode: 'default', path: stored?.path, name: stored?.name }
}

/** One project as the Client reads it. */
export interface ProjectValue {
  readonly projectId: string
  readonly title: string
  /** Bound work document, or `''` when none is bound yet (L5). */
  readonly docPath: string
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 last-mutation instant. */
  readonly updatedAt: string
}

/** Complete reconnect baseline for the Client's project projection. */
export interface ProjectBaseline {
  /** Projects in display order. */
  readonly projects: readonly ProjectValue[]
  /** Project ids in display order, so the order survives an empty project list. */
  readonly projectIds: readonly string[]
  /** Session id → owning project id, for every assignment. */
  readonly assignments: Readonly<Record<string, string>>
  /**
   * Project id → whether its row is open.
   *
   * An **absent** entry means the user has never touched that row, which is a
   * different state from `false` (folded deliberately) and is what lets the
   * browser open the group holding the current Session once. The record carries
   * that distinction; a default-filled map would erase it.
   */
  readonly expansions: Readonly<Record<string, boolean>>
  /**
   * Project id → the manual order of its members.
   *
   * Only projects with a recorded order appear. A missing entry is not "empty":
   * it means the project has no manual order, so the browser derives member
   * position from recency — which is exactly the state recency ordering wants,
   * and why this map is written whole rather than per member.
   */
  readonly orders: Readonly<Record<string, readonly string[]>>
  /**
   * Where a New Session with no stated destination lands.
   *
   * A project row's ＋ and the Ungrouped bucket's ＋ both state a destination of
   * their own and never consult this; it governs the unscoped entries — the
   * shell's New Session button and its shortcut, and any plugin that starts a
   * Session without a target.
   */
  readonly newSessionTarget: NewSessionTarget
  /**
   * The Workspace every New Session this plugin opens lands in.
   *
   * The two modes are `'default'` (the official first-use Workspace, resolved by the
   * Host) and `'specified'` (a Workspace the user pinned, identified by **path** —
   * see `spec.ts` for why not by id).
   */
  readonly baseWorkspace: BaseWorkspaceSetting
}

/** One ordered change after a generation's baseline. */
export type ProjectFollowIncrement =
  | { readonly type: 'upsert'; readonly project: ProjectValue }
  | { readonly type: 'remove'; readonly projectId: string }
  | { readonly type: 'order'; readonly projectIds: readonly string[] }
  | { readonly type: 'assigned'; readonly sessionId: string; readonly projectId: string }
  | { readonly type: 'unassigned'; readonly sessionId: string }

/** Project state stream; every generation starts with exactly one baseline. */
export type ProjectFollowFrame =
  | { readonly type: 'baseline'; readonly value: ProjectBaseline }
  | ProjectFollowIncrement

/** `create` request. */
export interface ProjectCreateRequest {
  readonly title: string
}
/** `create` result. */
export interface ProjectValueResult {
  readonly project: ProjectValue
}

/** `rename` request. */
export interface ProjectRenameRequest {
  readonly projectId: string
  readonly title: string
}
/** `rename` result. */
export type ProjectRenameValue = ProjectValueResult

/** `delete` request: removes the project and every assignment onto it. */
export interface ProjectDeleteRequest {
  readonly projectId: string
}

/** `reorder` request; an absent anchor appends to the end. */
export interface ProjectReorderRequest {
  readonly projectId: string
  readonly beforeId?: string
}
/** `reorder` result. */
export interface ProjectOrderValue {
  readonly projectIds: readonly string[]
}

/** `assign` request: files one Session under one project, replacing any previous. */
export interface ProjectAssignRequest {
  readonly sessionId: string
  readonly projectId: string
}
/** `assign` result. */
export interface ProjectAssignmentValue {
  readonly sessionId: string
  readonly projectId: string
}

/** `unassign` request: returns one Session to Ungrouped. */
export interface ProjectUnassignRequest {
  readonly sessionId: string
}
/** `unassign` result. */
export interface ProjectUnassignValue {
  readonly sessionId: string
  /** Whether an assignment existed and was removed. */
  readonly removed: boolean
}

/**
 * `setExpanded` request: record one project row's open/closed state.
 *
 * This is the plugin's own state, not the browser's view store: that store is
 * shared with the official plugin, whose mount prunes non-Workspace keys.
 */
export interface ProjectSetExpandedRequest {
  readonly projectId: string
  readonly expanded: boolean
}
/** `setExpanded` result. */
export interface ProjectExpansionValue {
  readonly projectId: string
  readonly expanded: boolean
}

/**
 * `setOrders` request: replace the manual order of every project at once.
 *
 * Whole-map rather than per-project because the three callers all need the same
 * thing: a drop rewrites one project and freezes the rest, switching to manual
 * freezes all of them, and switching to recency discards them all. A project
 * omitted from `orders` has its record removed, which is what makes recency mode
 * mean "no manual order" rather than "stale manual order".
 *
 * A project id the Host does not know is dropped rather than refused: it can only
 * come from a race with a delete, and failing the whole write would turn that
 * race into a lost drag.
 */
export interface ProjectSetOrdersRequest {
  readonly orders: Readonly<Record<string, readonly string[]>>
}
/** `setOrders` result: the map the Host actually holds. */
export interface ProjectOrdersValue {
  readonly orders: Readonly<Record<string, readonly string[]>>
}

/**
 * `setNewSessionTarget` request: choose where an unscoped New Session lands.
 *
 * Only the target travels. The Host spreads the stored global before writing, so
 * the project order it also holds survives — `global.set` replaces the whole
 * singleton rather than merging into it.
 */
export interface ProjectSetNewSessionTargetRequest {
  readonly target: NewSessionTarget
}
/** `setNewSessionTarget` result: the stored choice. */
export interface ProjectNewSessionTargetValue {
  readonly target: NewSessionTarget
}

/**
 * `setBaseWorkspace` request: choose the Workspace every New Session lands in.
 *
 * Only the setting travels. The Host spreads the stored global before writing, so the
 * project order it also holds survives — `global.set` replaces the whole singleton
 * rather than merging into it.
 */
export interface ProjectSetBaseWorkspaceRequest {
  readonly mode: BaseWorkspaceSetting['mode']
  /** Required when `mode` is `'specified'`; ignored otherwise. */
  readonly path?: string
  /** Display name captured at pick time; ignored otherwise. */
  readonly name?: string
}

/** `setBaseWorkspace` result: the stored setting, with `path`/`name` dropped for `'default'`. */
export interface ProjectBaseWorkspaceValue {
  readonly mode: BaseWorkspaceSetting['mode']
  readonly path?: string
  readonly name?: string
}

/**
 * `defaultWorkspacePath` result: where the official default Workspace would live.
 *
 * A pure read, asked for by the missing-底层工作区 dialog so it can name the path
 * that is gone. `path` is `null` when the OS Documents folder could not be read —
 * the dialog then says the path is unknown rather than showing a wrong one.
 *
 * The Client cannot derive this itself: it starts at the OS Documents folder, which
 * only the Host can query, and the official derivation is not an exported subpath.
 */
export interface ProjectDefaultWorkspacePathValue {
  readonly path: string | null
}
