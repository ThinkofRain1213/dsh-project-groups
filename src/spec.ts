/**
 * The projectGroups domain: this plugin's own durable state.
 *
 * ## Why a domain rather than a file
 *
 * `ctx.storageDomain` is the harness's standard data form: schema validation at
 * the durable boundary, atomic writes, and a `domain/changed` event per landed
 * write. It stores under `$DSH_HOME/storages/`, beside the official workspace
 * registry — parallel, never mixed, so disabling this plugin leaves the official
 * data exactly as it was.
 *
 * ## The four tables
 *
 * `projects` is keyed by project id and holds the display title. `assignments`
 * is keyed by **session id**, which is what makes "a session belongs to at most
 * one project" a structural fact rather than a rule to enforce: a key holds one
 * value, so a second assignment replaces the first. Moving a session between
 * projects is a single write, and removing it from its project is a delete.
 *
 * `expansions` and `orders` are keyed by project id and hold how the row is
 * presented: whether it is open, and the manual order of its members. They are
 * this plugin's own state rather than the browser's, because the browser's view
 * store is **shared with the official plugin** — both persist to
 * `dsh.workspace.view.v5`, and the official mount prunes every key that is not a
 * Workspace id (`retainAccountKeys` prunes `groupExpansion` and
 * `sessionOrderByAccount` alike). State kept there is deleted the first time the
 * official sidebar mounts, which is exactly what happens when this plugin is
 * switched off. See `src/vendored/README.md`.
 *
 * The Ungrouped bucket is deliberately not in `orders`: its key is in the
 * official retention list, so its order stays in the shared store and its
 * behaviour is upstream's, unchanged.
 *
 * `global.projectIds` is the display order, mirroring how the official registry
 * keeps `workspaceIds`. It is declared at version 1 rather than added later, so
 * reordering costs no schema migration.
 *
 * ## What is deliberately absent
 *
 * No directory: a project groups sessions, it does not own a folder. No session
 * `cwd`, no workspace id — nothing here can move a session, because only the
 * Host's session records decide that, and this domain never writes them.
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Project key: a generated id, never a title (titles are mutable and need not be unique). */
type ProjectId = string
/** Assignment key: the Session id, which is what bounds a Session to one project. */
type SessionId = string

/**
 * Durable shape of one project. `docPath` is reserved for the project's work
 * document (L5); an empty string means "no document bound yet" and is stored
 * rather than omitted so the field's absence never has to be distinguished
 * from its emptiness.
 */
export const projectRecord = z.object({
  title: z.string(),
  docPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored project record. */
export type ProjectRecord = z.infer<typeof projectRecord>

/**
 * Durable shape of one session's project membership. The key is the session id;
 * `projectId` names the project that owns it.
 */
export const assignmentRecord = z.object({
  projectId: z.string(),
  assignedAt: z.string(),
})

/** One stored assignment record. */
export type AssignmentRecord = z.infer<typeof assignmentRecord>

/**
 * Durable shape of one project's expansion state. The key is the project id.
 *
 * A record's **presence** carries meaning beyond its value: absent means "the
 * user has never touched this row", which is what lets the browser open the
 * group holding the current Session exactly once. A record with `expanded:
 * false` means the user folded it deliberately, and nothing may reopen it. That
 * distinction is why the state is a record per project rather than a boolean on
 * the project itself — an absent field and a `false` field would be one value.
 */
export const expansionRecord = z.object({
  expanded: z.boolean(),
})

/** One stored expansion record. */
export type ExpansionRecord = z.infer<typeof expansionRecord>

/**
 * Where a New Session with no stated destination lands.
 *
 * The three entries cover the states a Session can already be in — loose, or
 * inside some project — plus "the project that was used most recently". A fourth,
 * "one specific project", is deliberately absent: it needs a project picker and a
 * policy for what happens when that project is deleted, which is a design of its
 * own. Adding it later is a compatible change (see the schema note below).
 */
export const newSessionTarget = z.enum(['ungrouped', 'current', 'recent'])

/** One stored destination choice. */
export type NewSessionTarget = z.infer<typeof newSessionTarget>

/** How the base workspace is chosen. */
export const baseWorkspaceMode = z.enum(['default', 'specified'])

/** One stored base-workspace mode. */
export type BaseWorkspaceMode = z.infer<typeof baseWorkspaceMode>

/**
 * The base workspace: the Workspace every New Session this plugin opens lands in.
 *
 * ## Why `path` and not `workspaceId`
 *
 * Re-registering the same directory mints a **new** Workspace id (measured: deleting a
 * registration and creating the same path again yields a new id with an empty
 * `sessionIds`). A stored id would therefore go stale the moment the user removes and
 * re-adds the Workspace, while the path keeps resolving. Same reasoning as §3.8's
 * "find by path, never by title".
 *
 * A useful consequence: a Workspace the user deleted and re-added at the same path is
 * recognised again without them having to re-pick it.
 *
 * ## Why `name` is stored at all
 *
 * Display only. The card shows it without having to resolve the snapshot, and it is
 * what makes "'D:\我的项目' is gone" readable rather than a bare path. It is captured
 * at pick time and goes stale if the Workspace is renamed elsewhere — deliberately:
 * the plugin must not rewrite the user's setting because someone else edited a title.
 */
export const baseWorkspaceSetting = z.object({
  mode: baseWorkspaceMode,
  /** Required when `mode` is `'specified'`; absent for `'default'`. */
  path: z.string().optional(),
  /** Display name captured when the Workspace was picked. */
  name: z.string().optional(),
})

/** The stored base-workspace setting. */
export type BaseWorkspaceSetting = z.infer<typeof baseWorkspaceSetting>

/**
 * Durable shape of the global singleton: the project display order plus the
 * destination policy for unscoped New Sessions.
 *
 * `newSessionTarget` carries a default rather than being optional, and that is
 * what makes adding it compatible: the domain parses the stored global through
 * this schema on open (`storage-domain/src/index.ts`), so a unit written before
 * the field existed reads back as `'ungrouped'` instead of `undefined`. Verified
 * against the installed zod, and pinned by a host test.
 *
 * `baseWorkspace` uses the same mechanism for the same reason: a global written
 * before it existed reads back as `{ mode: 'default' }`, which is exactly the
 * behaviour such an install already had.
 */
export const globalRecord = z.object({
  projectIds: z.array(z.string()),
  newSessionTarget: newSessionTarget.default('ungrouped'),
  baseWorkspace: baseWorkspaceSetting.default({ mode: 'default' }),
})

/** The stored global singleton. */
export type GlobalRecord = z.infer<typeof globalRecord>

/**
 * Value served before the first global write.
 *
 * Typed rather than written inline: an inline literal widens `newSessionTarget`
 * to `string`, which makes the domain's global handle a union of the schema's
 * output and the widened initial, and every write then has to satisfy both.
 */
export const initialGlobal: GlobalRecord = {
  projectIds: [],
  newSessionTarget: 'ungrouped',
  baseWorkspace: { mode: 'default' },
}

/**
 * Durable shape of one project's manual session order. The key is the project id.
 *
 * This mirrors the browser view store's `sessionOrderByAccount`, which the
 * official plugin also writes to — and prunes. Keeping a project's order here
 * rather than there is what makes it survive the official sidebar mounting, the
 * same reason `expansions` lives here.
 *
 * Only the manual order is stored: under recency ordering a member's position is
 * derived from its `updatedAt`, so there is nothing to record.
 */
export const orderRecord = z.object({
  sessionIds: z.array(z.string()),
})

/** One stored manual-order record. */
export type OrderRecord = z.infer<typeof orderRecord>

/**
 * Domain name. `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`) makes this both the
 * backend unit name and the storage file-name segment, so it is snake_case
 * rather than the camelCase the wire namespace uses.
 */
export const PROJECT_DOMAIN_NAME = 'project_groups'

/**
 * The domain declaration. `defineDomain` validates the name, version and table
 * names at module load, before any medium is touched.
 *
 * `version` stays 1 while tables are added: a `single`-layout unit rejects a
 * stored version that differs from the spec's, and has no migration step, so
 * bumping it would make every existing file unreadable. An added table needs no
 * bump — a unit that predates it simply reads that table as empty
 * (`storage-json/src/format.ts`).
 */
export const projectDomainSpec = defineDomain({
  name: PROJECT_DOMAIN_NAME,
  version: 1,
  global: {
    schema: globalRecord,
    initial: initialGlobal,
  },
  tables: {
    projects: domainTable<ProjectId, ProjectRecord>(projectRecord),
    assignments: domainTable<SessionId, AssignmentRecord>(assignmentRecord),
    expansions: domainTable<ProjectId, ExpansionRecord>(expansionRecord),
    orders: domainTable<ProjectId, OrderRecord>(orderRecord),
  },
})
