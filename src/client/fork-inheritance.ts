/**
 * Make every branch inherit the project its source Session is filed under.
 *
 * ## Why the wrapper lives here rather than in `vendored/`
 *
 * The three branch entries do not share one surface above this one: the sidebar
 * menu and the keyboard shortcut go through `UiWorkspaceService.forkSession`,
 * while the message-level action in the official `ui-chat` calls
 * `ctx.sessions.fork` directly. `ClientSessions.fork` is the only thing both
 * reach, so the seam is there. That is a **plugin's own contribution**, not a
 * patch to upstream behaviour, which is why it does not belong in the vendored
 * tree or its ledger.
 *
 * ## Why a loaded-instance shadow rather than a provided service
 *
 * `ctx.provide('sessions', …)` throws once the name is registered (Cordis
 * refuses a second registration), so the service cannot be replaced. Shadowing
 * the method on the instance works because both call sites read it off the
 * object at call time — neither captures it early — and an instance property
 * takes precedence over the prototype method. The cleanup deletes the property,
 * which is all it takes to restore the prototype method.
 *
 * ## Why the write happens after the promise resolves
 *
 * `ClientSessions.fork` calls `onCreated`, then renames the child, then
 * returns; a failed rename rejects the whole call. Writing inside `onCreated`
 * would therefore leave an assignment for a fork the caller was told failed.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The single method this module shadows, reduced to its call shape. */
export interface ForkableSessions {
  fork(opts: ForkOptions): Promise<SessionId>
}

/** The options `ClientSessions.fork` accepts, as far as this wrapper sees them. */
export interface ForkOptions {
  readonly sessionId: SessionId
  readonly atSeq?: number
  readonly increaseTitle?: boolean
  readonly onCreated?: (childId: SessionId) => void
  readonly allowMigration?: boolean
}

/** What the wrapper needs from the project model, injected so it stays testable. */
export interface ForkInheritanceDeps {
  /** The project owning one Session, or `undefined` when it is Ungrouped. */
  projectOf(parentId: SessionId): string | undefined
  /** File a Session under a project. */
  assign(childId: SessionId, projectId: string): Promise<void>
  /** Report a swallowed failure; never rethrown. */
  warn(message: string, error: unknown): void
}

/**
 * Marks a function this module already wrapped.
 *
 * A module-scoped marker rather than a `WeakSet` so a reloaded copy of this
 * module still recognises the wrapper installed by the previous one — a
 * `WeakSet` would be per-module-instance and would let a second wrap through.
 */
const WRAPPED = Symbol.for('dsh-project-groups/fork-inheritance')

/**
 * File a freshly forked Session under its parent's project.
 *
 * Whole-body containment is deliberate: this runs after the fork already
 * succeeded, so nothing here may fail the caller. A lookup that throws and a
 * refused write are both reported through `warn` and dropped.
 * @param parentId - the Session that was branched from.
 * @param childId - the Session the fork created.
 * @param deps - project lookup, assignment, and the warning sink.
 */
export function inheritForkProject(
  parentId: SessionId,
  childId: SessionId,
  deps: ForkInheritanceDeps,
): void {
  try {
    const projectId = deps.projectOf(parentId)
    // An Ungrouped parent is a real answer, not a failure: the child simply
    // inherits nothing. Writing nothing here is what keeps "branch from an
    // ungrouped Session" from needing a special case.
    if (projectId === undefined) return
    // Not awaited: the caller's fork has already resolved, and a write that
    // lands a beat later is indistinguishable from one that landed now.
    void deps.assign(childId, projectId).catch((error: unknown) => {
      deps.warn('project-groups: fork assignment failed:', error)
    })
  } catch (error: unknown) {
    deps.warn('project-groups: fork assignment failed:', error)
  }
}

/**
 * Shadow `sessions.fork` so every branch inherits its source's project.
 * @param sessions - the live Session service instance.
 * @param deps - project lookup, assignment, and the warning sink.
 * @returns a disposer restoring the original method. Idempotent: wrapping twice
 * returns a no-op disposer rather than stacking a second wrapper.
 */
export function wrapFork(sessions: ForkableSessions, deps: ForkInheritanceDeps): () => void {
  const current = sessions.fork
  // A second wrap would assign twice for one fork, so the already-wrapped case
  // returns a no-op instead of wrapping the wrapper.
  if ((current as unknown as Record<symbol, boolean>)[WRAPPED] === true) return () => {}

  const wrapped = async (opts: ForkOptions): Promise<SessionId> => {
    // `call(sessions, …)` is load-bearing: the real `fork` reads `this.list`,
    // `this.manager`, and `this.projectList`. Losing `this` breaks **every**
    // fork, not just the inheritance.
    const childId = await current.call(sessions, opts)
    // Only after the whole call resolved, so a failed child rename writes
    // nothing. The caller's own `onCreated` was already invoked inside `fork`.
    inheritForkProject(opts.sessionId, childId, deps)
    return childId
  }
  ;(wrapped as unknown as Record<symbol, boolean>)[WRAPPED] = true

  // An own property shadows the prototype method. The original is put back
  // rather than deleted: `delete` only restores a *prototype* method, and an
  // instance that carried its own `fork` (or a fake in a test) would lose the
  // method entirely.
  ;(sessions as unknown as { fork: unknown }).fork = wrapped

  let restored = false
  return () => {
    if (restored) return
    restored = true
    // Ownership check, not an unconditional restore. Cordis runs a fibre's
    // disposers when it is replaced, and that can happen *after* the
    // replacement's `apply`: the new apply sees this wrapper's marker, returns a
    // no-op, and then this disposer would put the original back — leaving the
    // live instance unwrapped, so inheritance disappears until a restart with
    // nothing in the log. `index.ts`'s module-level service captures guard the
    // same race the same way.
    if ((sessions as unknown as { fork: unknown }).fork !== wrapped) return
    ;(sessions as unknown as { fork: unknown }).fork = current
  }
}
