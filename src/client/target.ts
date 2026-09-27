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
 * @param recent - the project holding the most recently active Session.
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
  }
}

/**
 * The project holding the most recently active Session.
 *
 * Mirrors the Host's `recentWorkspace` (`packages/client/ui-workspace/src/client/
 * navigation.ts`) so the two behave the same way at their edges:
 *
 *  - a project with no Sessions falls back to its own `createdAt`, so an empty
 *    project can still be chosen — without it, a project the user just created
 *    could never be the answer;
 *  - the comparison is strictly `>`, so a tie keeps the project that comes first
 *    in display order rather than the one that happened to be visited last.
 *
 * @param projects - projects in display order.
 * @param updatedAt - Session id → last activity.
 * @param members - the Session ids filed under one project.
 * @returns the project id, or `undefined` when there are no projects.
 */
export function recentProject(
  projects: readonly ProjectValue[],
  updatedAt: SessionTimes,
  members: (projectId: string) => readonly SessionId[],
): string | undefined {
  let selected: string | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const project of projects) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of members(project.projectId)) {
      const time = updatedAt[sessionId]
      if (time !== undefined) latest = Math.max(latest, time)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(project.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = project.projectId
      selectedTime = latest
    }
  }
  return selected
}
