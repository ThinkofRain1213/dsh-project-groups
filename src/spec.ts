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
 * ## The two tables
 *
 * `projects` is keyed by project id and holds the display title. `assignments`
 * is keyed by **session id**, which is what makes "a session belongs to at most
 * one project" a structural fact rather than a rule to enforce: a key holds one
 * value, so a second assignment replaces the first. Moving a session between
 * projects is a single write, and removing it from its project is a delete.
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
 * Domain name. `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`) makes this both the
 * backend unit name and the storage file-name segment, so it is snake_case
 * rather than the camelCase the wire namespace uses.
 */
export const PROJECT_DOMAIN_NAME = 'project_groups'

/**
 * The domain declaration. `defineDomain` validates the name, version and table
 * names at module load, before any medium is touched.
 */
export const projectDomainSpec = defineDomain({
  name: PROJECT_DOMAIN_NAME,
  version: 1,
  global: {
    schema: z.object({ projectIds: z.array(z.string()) }),
    initial: { projectIds: [] },
  },
  tables: {
    projects: domainTable<ProjectId, ProjectRecord>(projectRecord),
    assignments: domainTable<SessionId, AssignmentRecord>(assignmentRecord),
  },
})
