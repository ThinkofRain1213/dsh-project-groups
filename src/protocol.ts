/**
 * Wire vocabulary shared by the Host half and this plugin's own Client
 * contribution.
 *
 * Both halves key off the endpoint names below, so a rename here is a breaking
 * change on both sides at once rather than a silent mismatch at runtime: the
 * Client contribution's descriptors and the Host's `@Remote` exports are
 * derived from the same constants.
 *
 * These are plain data shapes. Nothing crosses that is not JSON, which is what
 * lets both codecs be pass-throughs (see `src/client/remote.ts`).
 */

/** The Cordis service key owning these methods, and the default wire namespace. */
export const PROJECT_SERVICE_KEY = 'projectController'

/** The Remote namespace the Client calls (`ctx.remote.projectGroups`). */
export const PROJECT_NAMESPACE = 'projectGroups'

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
