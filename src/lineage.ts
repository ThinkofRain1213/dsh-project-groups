/**
 * The Session-lineage walk: which project owns a Session, following subagent ancestry.
 *
 * This is a **pure** decision over two lookups, extracted from `ProjectController` so the rule
 * can be asserted against the shipped code rather than a transcription of it. The harness
 * (`scripts/verify-project-injection.mjs`) had its own copy of the walk, which meant every check
 * there verified the copy: changing the `origin !== 'subagent'` rule, the cycle guard, or the
 * filed-ancestor precedence would have left all of them green. The copy had already drifted —
 * it dropped the real implementation's `sessions === undefined` guard.
 *
 * Pure on purpose: no `this`, no domain handle, no service registry. `ProjectController` passes
 * the two faces in, and a test passes fixtures.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The part of a Session header the walk reads. */
export interface LineageHeader {
  /** `'subagent'` is the only origin whose parent is an ancestor. */
  readonly origin?: string
  readonly parentSession?: SessionId
}

/** The live Sessions face, reduced to the one lookup the walk needs. */
export interface LineageSessions {
  get(sessionId: SessionId): { readonly header: LineageHeader } | undefined
}

/** The durable assignment table, reduced to the one lookup the walk needs. */
export interface LineageAssignments {
  get(sessionId: string): { readonly projectId: string } | undefined
}

/**
 * Walk one Session's lineage to the project that owns it.
 *
 * ## Why a subagent's parent counts and a fork's does not
 *
 * A subagent is an extension of its parent's work, so it belongs to whatever project the parent
 * is filed under. A fork is an independent conversation the user deliberately started, so it
 * does not inherit — the same judgement the official walk documents on its own `origin` check.
 *
 * ## A closed ancestor is still readable
 *
 * The parent's **project** is available even after that parent Session has closed: `assignments`
 * is this plugin's own durable table keyed by session id, and the id survives in
 * `header.parentSession`. Only climbing *past* the ancestor needs the live store.
 *
 * ## Termination
 *
 * The `visited` set ends a cycle in a corrupt lineage; the `parent === undefined` branch stops
 * when the store can no longer be read, which is the honest answer rather than a guess.
 * @param assignments - the durable session-id → project table.
 * @param sessions - the live Sessions face, or `undefined` when the service is absent.
 * @param sessionId - the Session whose owning project is required.
 * @returns the owning project id, or `undefined` when the Session is unfiled.
 */
export function projectOwningSession(
  assignments: LineageAssignments,
  sessions: LineageSessions | undefined,
  sessionId: SessionId,
): string | undefined {
  // The Session itself: the common case, and the only case for an ordinary one.
  const direct = assignments.get(String(sessionId))?.projectId
  if (direct !== undefined) return direct

  if (sessions === undefined) return undefined

  let header = sessions.get(sessionId)?.header
  if (header === undefined) return undefined
  // Only a subagent's parent is a candidate ancestor.
  if (header.origin !== 'subagent') return undefined

  const visited = new Set<SessionId>([sessionId])
  while (header.parentSession !== undefined) {
    const parentId = header.parentSession
    if (visited.has(parentId)) return undefined // cycle in a corrupt lineage
    visited.add(parentId)
    const filed = assignments.get(String(parentId))?.projectId
    if (filed !== undefined) return filed
    const parent = sessions.get(parentId)
    // A closed ancestor cannot be inspected further: the store holds live Sessions only, and the
    // next parent id rides on a header we cannot read. Stopping is the honest answer; continuing
    // would mean guessing.
    if (parent === undefined) return undefined
    header = parent.header
    if (header.origin !== 'subagent') return undefined
  }

  return undefined
}
