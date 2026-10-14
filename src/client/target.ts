/**
 * Where an unscoped New Session lands.
 *
 * The Host's own navigation picks a Workspace for a New Session by guessing:
 * `explicit target ?? the current Session's Workspace ?? the most recently used
 * one` (`packages/client/ui-workspace/src/client/navigation.ts`). This plugin
 * deliberately replaced that guess with a fixed default Workspace, because the
 * guess made the destination depend on whatever the user last did.
 *
 * Projects need the choice back, in a form the user controls rather than one the
 * app infers. So the policy is a stored setting with three answers, and it is
 * resolved here — as plain functions over plain data — so it can be reasoned
 * about and tested without a browser.
 *
 * A project row's ＋ and the Ungrouped bucket's ＋ never reach this file: they
 * state their own destination through `beforeOpen`, which takes precedence.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProjectValue, NewSessionTarget } from '../protocol.ts'

/** Session id → the Session's last activity, as the browser reports it. */
export type SessionTimes = Readonly<Record<string, number>>

/**
 * Resolve the policy to a project id, or `undefined` for Ungrouped.
 *
 * Ungrouped is the absence of an assignment rather than a project, so
 * `undefined` is the value that means "no project" throughout this plugin.
 *
 * **With no current Session the answer is Ungrouped**, not a guess. That state is
 * reachable — archiving the current Session clears the selection — and the Host's
 * own answer to it is to show a workspace picker rather than choose. Ungrouped is
 * this model's legal default, so it needs no picker of its own.
 * @param target - the stored policy.
 * @param currentSessionId - the Session the user is looking at, when there is one.
 * @param projectOf - owner lookup for one Session.
 * @param recent - the destination holding the most recently active Session, which
 * may be Ungrouped (`undefined`).
 * @returns the project to file the new Session under, or `undefined` for Ungrouped.
 */
export function resolveTarget(
  target: NewSessionTarget,
  currentSessionId: SessionId | undefined,
  projectOf: (sessionId: SessionId) => string | undefined,
  recent: () => string | undefined,
): string | undefined {
  switch (target) {
    case 'ungrouped':
      return undefined
    case 'current':
      return currentSessionId === undefined ? undefined : projectOf(currentSessionId)
    case 'recent':
      return recent()
    default: {
      // Exhaustiveness, checked at build time.
      //
      // The return type includes `undefined`, so a new `NewSessionTarget` member added later
      // would not be a type error: the switch would fall out of the bottom and the function
      // would answer `undefined` — which means **Ungrouped**, a real destination rather than
      // a failure. Assigning the narrowed value to `never` turns that silent default into a
      // compile error the moment the union grows.
      const unhandled: never = target
      throw new Error(`unhandled new-session target: ${String(unhandled)}`)
    }
  }
}

/**
 * The destination `recent` resolves to: the holder of the most recently active
 * Session, where the holder may be a project **or Ungrouped**.
 *
 * Ungrouped is a real answer rather than the absence of one. "The last Session I
 * worked in belongs to no project" is a state the user can be in, and there is no
 * equivalent in the Host's `recentWorkspace` because every Session there belongs
 * to some Workspace. So this mirrors that function's edge rules and adds the
 * third candidate it has no room for.
 *
 * Blank Sessions contribute nothing, because the activity map excludes them: a
 * blank row carries its creation time, and the Session being placed is itself
 * blank and already in the list — counting it would let the Session choose its
 * own destination. See the map's assembly in `vendored/client/index.ts`.
 *
 * @param projects - projects in display order.
 * @param activity - Session id → last activity, blank Sessions already excluded.
 * @param members - the Session ids filed under one project.
 * @param loose - the ids in no project, i.e. the Ungrouped bucket. Typed as plain
 * strings rather than `SessionId`s because it is, by construction, a subset of
 * `activity`'s own key domain — the caller derives it with `Object.keys`.
 * @param exclude - the Session being placed, never a candidate for its own destination.
 * @returns the project id, or `undefined` for Ungrouped.
 */
export function recentDestination(
  projects: readonly ProjectValue[],
  activity: SessionTimes,
  members: (projectId: string) => readonly SessionId[],
  loose: readonly string[],
  exclude?: SessionId,
): string | undefined {
  let selected: string | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  // Strict `>` keeps whichever candidate was considered first on a tie, so
  // Ungrouped — considered last — never wins one against a project. That matches
  // the Host's own rule (a tie follows display order) rather than inventing a
  // preference for Ungrouped.
  const consider = (candidate: string | undefined, latest: number): void => {
    if (latest <= selectedTime) return
    selected = candidate
    selectedTime = latest
  }

  // The Session being placed is skipped in both scans below.
  //
  // The "blank Sessions are excluded from `activity`" rule used to be an invariant stated only
  // in prose, enforced entirely by the caller. If any caller leaked an entry for the Session
  // currently being placed, that Session would count as its own most recent activity and
  // select its own destination — defeating the whole policy, and doing so invisibly because
  // the result still looks like a plausible project. Taking the id makes the rule structural:
  // the caller already has it, and there is no longer a way to call this without excluding
  // the one Session that must never be a candidate.
  const isCandidate = (sessionId: SessionId): boolean => sessionId !== exclude

  for (const project of projects) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of members(project.projectId)) {
      if (!isCandidate(sessionId)) continue
      const time = activity[sessionId]
      if (time !== undefined) latest = Math.max(latest, time)
    }
    // Without this a project the user just created could never be chosen.
    //
    // Guarded against a non-finite parse: `Date.parse` returns NaN for an
    // unparseable `createdAt`, and NaN would poison `consider` rather than merely
    // losing this one candidate. `latest <= selectedTime` is false when `latest` is
    // NaN, so `consider` assigns `selectedTime = NaN`; every later comparison is then
    // false too, `consider` returns early for every remaining candidate, and the
    // selection freezes on whichever project happened to come first — silently
    // inverting the "most recently active" rule this function exists to implement.
    // A record with a bad date therefore contributes nothing, which is the honest
    // reading of a date that cannot be parsed.
    if (latest === Number.NEGATIVE_INFINITY) {
      const created = Date.parse(project.createdAt)
      if (Number.isFinite(created)) latest = created
    }
    consider(project.projectId, latest)
  }

  let looseLatest = Number.NEGATIVE_INFINITY
  for (const sessionId of loose) {
    if (sessionId === exclude) continue
    const time = activity[sessionId]
    if (time !== undefined) looseLatest = Math.max(looseLatest, time)
  }
  // No `createdAt` fallback: Ungrouped is not an entity and has no creation of
  // its own, so with nothing loose to go on it simply cannot win — which is the
  // honest answer, and leaves the newest project to take it.
  consider(undefined, looseLatest)

  return selected
}
