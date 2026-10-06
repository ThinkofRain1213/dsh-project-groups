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
import type { BaseWorkspaceSetting, DocSpecMode, NewSessionTarget } from './spec.ts'

export type { BaseWorkspaceMode, BaseWorkspaceSetting, DocSpecMode, NewSessionTarget } from './spec.ts'

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
 *
 * ## The optional new memory
 *
 * `requested` is the Workspace the caller is storing now. The 更换… chooser replaces
 * the remembered Workspace **without touching the mode**, so it calls this with the
 * current mode and the newly picked path; a plain click on the 默认 card passes nothing
 * and keeps what was already there.
 *
 * Keeping that in one place is the whole point of this function: the alternative was a
 * second expression at each call site, which is exactly the drift described above.
 * @param stored - the setting as it stands, or `undefined` before any write.
 * @param requested - the memory being stored now; absent leaves the stored one alone.
 * @returns the `'default'` setting, carrying whichever memory applies.
 */
export function withDefaultMode(
  stored: BaseWorkspaceSetting | undefined,
  requested?: { readonly path?: string | undefined; readonly name?: string | undefined },
): BaseWorkspaceSetting {
  return {
    mode: 'default',
    path: requested?.path ?? stored?.path,
    name: requested?.name ?? stored?.name,
  }
}

/** One project as the Client reads it. */
export interface ProjectValue {
  readonly projectId: string
  readonly title: string
  /**
   * Directories associated with this project, in display order.
   *
   * Any number, including none. A plain list rather than objects with a
   * primary/major flag: that distinction was designed and dropped, and the wire
   * shape must not reserve room for it.
   */
  readonly directories: readonly string[]
  /** Bound work document, or `''` when none is bound yet (L5). */
  readonly docPath: string
  /**
   * This project's spec override: `'none'`, an uploaded file name, or absent to
   * inherit the global choice. `null` on the wire is never used — absence is the
   * inheritance signal, so an explicit `null` would be a second spelling of it.
   */
  readonly docSpec?: DocSpecMode | string
  /**
   * The spec content hash the document was last written against, or absent when
   * the document has never been written. The settings surface shows it only as
   * "aligned / needs attention", never as a hash.
   */
  readonly docSpecUsed?: string
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
  /**
   * Whether creating a project also opens a Session inside it.
   *
   * Read by the sidebar region, which is where the create dialog lives: that half
   * decides whether to follow the official add-workspace flow, so the value has to
   * reach it through the inject face rather than staying in the settings card.
   */
  readonly createOpensSession: boolean
  /**
   * Whether a Session's project info is injected into its requests.
   *
   * The base injection: the project's title and associated directories, delivered
   * as a `systemPrompt.context()` contribution. Reading through a default on the
   * Client side is deliberate — an older Host did not inject, so a Client that
   * assumes `true` would show a switch that lies.
   */
  readonly injectProjectInfo: boolean
  /**
   * Whether the project's work-document line is injected alongside the base info.
   *
   * The extra feature, and a separate switch on purpose: it is an addition on top
   * of {@link injectProjectInfo}, not a variant of it.
   */
  readonly injectProjectDoc: boolean
  /**
   * Which spec source applies before any project override.
   *
   * Read by the settings card's three-option control and by the project dialogs'
   * spec row, which labels the inherited entry with whatever this resolves to.
   * Optional on the wire so a Client running against an older Host reads the
   * schema default rather than `undefined`.
   */
  readonly docSpecMode?: DocSpecMode
  /**
   * The uploaded spec the `'custom'` mode names; `''` when the user picked
   * `'custom'` but has not chosen a file yet.
   */
  readonly docSpecFileName?: string
  /** Whether the project dialogs expose a per-project spec row. */
  readonly perProjectDocSpec?: boolean
  /**
   * Every uploaded spec's file name, sorted.
   *
   * Carried on the baseline rather than fetched on demand because two surfaces
   * need it at once — the settings dialog and every project dropdown — and a
   * round trip per dialog would show an empty list for a frame.
   */
  readonly specs?: readonly string[]
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
  /**
   * Directories to associate at creation time; omitted means none.
   *
   * Carried on create rather than requiring a follow-up `setDirectories` call so
   * the create dialog can collect a directory list and commit it in one write —
   * a project that briefly existed with no directories would be a state the user
   * never asked for.
   */
  readonly directories?: readonly string[]
  /**
   * Spec override to store at creation time; omitted means inherit the global
   * choice.
   *
   * Carried on create for the same reason as `directories`: the create dialog
   * collects everything it wants in one dialog, and a project that briefly
   * existed with the wrong spec would be a state the user never asked for.
   */
  readonly docSpec?: string | null
}
/** `create` result. */
export interface ProjectValueResult {
  readonly project: ProjectValue
}

/**
 * `update` request: replace one project's title and directory list together.
 *
 * One verb rather than a rename followed by a directory write, because the edit
 * dialog commits both fields with one button. Two calls would leave a visible
 * intermediate state — the row retitled while its directories are still the old
 * ones — and a failure between them would leave exactly that state durably. The
 * atomic form also matches `create`, which already takes both.
 */
export interface ProjectUpdateRequest {
  readonly projectId: string
  readonly title: string
  /** The complete list, in display order. An empty list is a real value. */
  readonly directories: readonly string[]
}
/** `update` result. */
export type ProjectUpdateValue = ProjectValueResult

/** `delete` request: removes the project and every assignment onto it. */
export interface ProjectDeleteRequest {
  readonly projectId: string
}
/**
 * `delete` result: nothing.
 *
 * Declared so the Client's descriptor names a protocol export like every other
 * result does, and so the diagnostic is truthful — `remove` returns `void`, and
 * the removal is observed through the next `baseline` frame rather than an answer.
 */
export type ProjectDeleteValue = void

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
 * `setCreateOpensSession` request: whether creating a project opens a Session.
 *
 * Only the flag travels. The Host spreads the stored global before writing, so the
 * project order and every other setting it holds survive — `global.set` replaces the
 * whole singleton rather than merging into it.
 */
export interface ProjectSetCreateOpensSessionRequest {
  readonly value: boolean
}

/** `setCreateOpensSession` result: the stored value. */
export interface ProjectCreateOpensSessionValue {
  readonly value: boolean
}

/**
 * `setDirectories` request: replace one project's associated directories.
 *
 * **Whole-list** rather than add/remove-one, for the reason `setOrders` is
 * whole-map: every caller already holds the complete list it wants stored (the
 * edit dialog's rows), so sending the list is the honest request, and the Host
 * never has to infer intent from a partial edit.
 */
export interface ProjectSetDirectoriesRequest {
  readonly projectId: string
  /** The complete list, in display order. An empty list is a real value: no directories. */
  readonly directories: readonly string[]
}

/** `setDirectories` result: the list the Host stored. */
export interface ProjectDirectoriesValue {
  readonly projectId: string
  readonly directories: readonly string[]
}

/**
 * `setInjectProjectInfo` request: whether to inject the project's name and directories.
 *
 * Only the flag travels. The Host spreads the stored global before writing, so the
 * project order and every other setting it holds survive — `global.set` replaces the
 * whole singleton rather than merging into it.
 */
export interface ProjectSetInjectProjectInfoRequest {
  readonly value: boolean
}

/** `setInjectProjectInfo` result: the stored value. */
export interface ProjectInjectProjectInfoValue {
  readonly value: boolean
}

/** `setInjectProjectDoc` request: whether to inject the work-document line too. */
export interface ProjectSetInjectProjectDocRequest {
  readonly value: boolean
}

/** `setInjectProjectDoc` result: the stored value. */
export interface ProjectInjectProjectDocValue {
  readonly value: boolean
}

/**
 * `setDocSpecMode` request: which spec source applies before any override.
 *
 * Only the mode travels; the Host spreads the stored global before writing, so
 * the project order and every other setting survive.
 */
export interface ProjectSetDocSpecModeRequest {
  readonly mode: DocSpecMode
}

/** `setDocSpecMode` result: the stored choice. */
export interface ProjectDocSpecModeValue {
  readonly mode: DocSpecMode
}

/**
 * `setDocSpecFileName` request: the uploaded spec the `'custom'` mode names.
 *
 * A bare `*.md` file name, never a path: uploaded specs live only under this
 * plugin's own directory, so the Host owns the directory and the wire carries
 * the identity. An empty string is the "selected but not chosen yet" state.
 */
export interface ProjectSetDocSpecFileNameRequest {
  readonly name: string
}

/** `setDocSpecFileName` result: the stored name. */
export interface ProjectDocSpecFileNameValue {
  readonly name: string
}

/** `setPerProjectDocSpec` request: whether project dialogs expose a spec row. */
export interface ProjectSetPerProjectDocSpecRequest {
  readonly value: boolean
}

/** `setPerProjectDocSpec` result: the stored value. */
export interface ProjectPerProjectDocSpecValue {
  readonly value: boolean
}

/**
 * `setProjectDocSpec` request: one project's spec override.
 *
 * Four cases, and each is a distinct stored state — collapsing any two of them
 * would lose a distinction the project dialog shows:
 *
 * | `spec`          | stored            | resolves to            |
 * |-----------------|-------------------|------------------------|
 * | `null`          | key absent        | the global choice      |
 * | `'none'`        | `'none'`          | no spec at all         |
 * | `'default'`     | `'default'`       | the built-in spec      |
 * | a file name     | that name         | that uploaded file     |
 *
 * `null` clears rather than storing a sentinel, because absence is what "inherit"
 * means; `'none'` and `'default'` are deliberate choices that must stay
 * distinguishable from it AND from each other.
 */
export interface ProjectSetProjectDocSpecRequest {
  readonly projectId: string
  readonly spec: DocSpecMode | string | null
}

/** `setProjectDocSpec` result: the project's stored override, or `null` when cleared. */
export interface ProjectProjectDocSpecValue {
  readonly projectId: string
  readonly spec: DocSpecMode | string | null
}

/** `uploadSpec` request: one uploaded spec's file name and text. */
export interface ProjectUploadSpecRequest {
  readonly name: string
  readonly content: string
}

/**
 * `uploadSpec` result.
 *
 * `written: false` means the name is unsafe or already taken — the surface's rule
 * is to refuse rather than overwrite a file the user may have edited, and it
 * reports "already exists" instead.
 */
export interface ProjectUploadSpecValue {
  readonly written: boolean
  /** The names now present, so the caller can refresh its list in one round trip. */
  readonly specs: readonly string[]
}

/** `deleteSpec` request: the uploaded spec to remove. */
export interface ProjectDeleteSpecRequest {
  readonly name: string
}

/** `deleteSpec` result: whether a file was removed, plus the remaining names. */
export interface ProjectDeleteSpecValue {
  readonly removed: boolean
  readonly specs: readonly string[]
}

/** `specsUsedBy` request: which projects reference one uploaded spec. */
export interface ProjectSpecsUsedByRequest {
  readonly name: string
}

/**
 * `specsUsedBy` result: the titles of projects that would fall back if the named
 * spec were deleted.
 *
 * Titles rather than ids: the caller shows them to the user in a confirmation.
 */
export interface ProjectSpecsUsedByValue {
  readonly titles: readonly string[]
}

/** `readSpec` request: fetch one uploaded spec's text for preview. */
export interface ProjectReadSpecRequest {
  readonly name: string
}

/** `readSpec` result: the text, or `null` when the file is absent. */
export interface ProjectReadSpecValue {
  readonly content: string | null
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

/**
 * `rebuildBaseWorkspace` result: the Workspace that now exists at the base path.
 *
 * `mode` reports what the plugin's setting holds **after** the rebuild, and it is part of the
 * result rather than assumed because the repair is not always purely a filesystem action. In
 * `'default'` mode the official pointer is deliberately permanent — upstream documents that
 * "deleting that registration permanently disables automatic creation" — so re-registering the
 * path mints an id that pointer never adopts. The plugin therefore takes the path over into its
 * own setting, which its resolver does read, and the caller must be able to see that this is what
 * happened rather than discovering it as a surprise on the settings card.
 */
export interface ProjectRebuildBaseWorkspaceValue {
  /** The canonical path the registry stored, after `realpathNormalize`. */
  readonly path: string
  readonly workspaceId: string
  /** The Workspace's title as registered. */
  readonly title: string
  /** The setting's mode once the rebuild is complete. */
  readonly mode: BaseWorkspaceSetting['mode']
}
