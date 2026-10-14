/**
 * The complete account memberships a Pin order write reconciles against,
 * derived from the same Host snapshots the browser orders by, so the
 * UiWorkspace service can complete the write without the browser in the loop.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FLAT_SESSION_ORDER_KEY } from './stores.ts'
import { owningGroupKey, sessionMemberIds, type SessionRowState, UNGROUPED_KEY } from './tree.ts'

/** What `pinSessionOrder` reconciles a pinned Session's accounts against. */
export interface PinOrderSource {
  members: Readonly<Record<string, readonly SessionId[]>>
  summaries: SessionListState['byId']
  rowState: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>
}

/**
 * Every account's complete membership: each Workspace, Ungrouped, and the flat list.
 * @param workspaces - current Host Workspaces.
 * @param list - current Session list snapshot.
 * @param rowState - registry-global pin and archive sets.
 * @returns the order source for one pin write.
 */
export function pinOrderSource(
  workspaces: readonly WorkspaceView[],
  list: SessionListState,
  rowState: PinOrderSource['rowState'],
): PinOrderSource {
  const accounted = new Set(workspaces.flatMap(workspace => workspace.sessionIds))
  // Assembled through a Map so a key collision is *reported*, not silently resolved.
  //
  // `Object.fromEntries` keeps the last value for a duplicate key. The Workspace entries came
  // first and the two reserved accounts after, so a Workspace whose id was `UNGROUPED_KEY` ('')
  // or `FLAT_SESSION_ORDER_KEY` — or two Workspaces sharing an id — would have been replaced by
  // the later entry, and the pin write would reconcile against the wrong account with nothing
  // said. Unreachable today: the Host mints UUIDs for Workspace ids, and `''` is this plugin's
  // synthetic group key, not a registry id. The check exists because that is an assumption
  // rather than a guarantee.
  //
  // Warned rather than thrown, deliberately: `pinSession` reaches here through a
  // `(sessionId) => void` injected share that the UI calls fire-and-forget, so a throw would
  // surface as an unhandled rejection — a worse outcome than the collision, which is why the
  // reserved account stays authoritative and the log names what happened.
  const members = new Map<string, readonly SessionId[]>()
  for (const workspace of workspaces) {
    if (members.has(workspace.workspaceId) || workspace.workspaceId === UNGROUPED_KEY
      || workspace.workspaceId === FLAT_SESSION_ORDER_KEY) {
      console.warn(`dsh-project-groups: pin order skipped a duplicate or reserved account id ${JSON.stringify(workspace.workspaceId)}`)
      continue
    }
    // Copied rather than aliased: the registry's own array is mutated in place as Sessions are
    // filed, so holding the reference would let the order source change under a write that had
    // already read it. The two derived accounts below are new arrays by construction.
    members.set(workspace.workspaceId, [...workspace.sessionIds])
  }
  // Ungrouped membership by the **same** rule the flat account uses.
  //
  // It used to be `list.ids.filter(id => byId[id] !== undefined && !accounted.has(id))`, which
  // is weaker than `sessionMemberIds`' `visibleSessionIds(..., 'show')`: subagent sessions and
  // non-current blank placeholders that no Workspace claims pass the first test and fail the
  // second, so they leaked into the Ungrouped account. `pinSessionOrder` would then reconcile
  // the pin against an account holding rows the tree never renders.
  const visible = sessionMemberIds(list)
  members.set(UNGROUPED_KEY, visible.filter(id => !accounted.has(id)))
  members.set(FLAT_SESSION_ORDER_KEY, visible)
  return {
    members: Object.fromEntries(members),
    // Aliased, not copied, and that is the intended contract: both are read synchronously by
    // `pinSessionOrder` in the same tick, so a snapshot would be pure allocation. Copied above
    // only where the value outlives the call more visibly than these do.
    summaries: list.byId,
    rowState,
  }
}

/**
 * The accounts a pinned Session leads: its group (or Ungrouped) and the flat list.
 * @param workspaces - current Host Workspaces.
 * @param sessionId - the Session being pinned.
 * @returns the account keys `pinSessionOrder` fronts.
 */
export function pinOrderAccounts(workspaces: readonly WorkspaceView[], sessionId: SessionId): readonly string[] {
  return [owningGroupKey(workspaces, sessionId), FLAT_SESSION_ORDER_KEY]
}
