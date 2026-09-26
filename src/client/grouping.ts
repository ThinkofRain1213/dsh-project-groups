/**
 * The grouping model this plugin feeds the vendored sidebar browser.
 *
 * ## What this is
 *
 * The browser renders group headings from a `GroupSource[]`. We supply the
 * array; the browser still reads Sessions, Workspaces, the archived set, pins,
 * and loading phases from the Host exactly as before.
 *
 * ## L1a: everything Ungrouped
 *
 * {@link EMPTY_GROUPING} is an **active override that claims no Session**. The
 * browser treats unclaimed Sessions as stray and trails them under its own
 * Ungrouped bucket, so the net effect is every visible Session in one list —
 * which is this round's goal.
 *
 * An empty array is not the same as no override at all: `undefined` means
 * "group by the Host Workspace registry" (upstream behaviour), while `[]` means
 * "group by nothing", which is what puts every Session under Ungrouped. That
 * distinction is why the observable's *value* carries the inactive state rather
 * than the observable itself being absent.
 *
 * ## Why the Host is unaffected
 *
 * Grouping is a derivation in the browser (`tree.ts` `deriveGroups`). Nothing
 * here writes Workspace membership, `cwd`, or archive state, so switching this
 * back to `undefined` — or disabling the plugin — restores the official
 * workspace-grouped sidebar with all its data intact.
 *
 * L1 replaces {@link EMPTY_GROUPING} with sources derived from the project
 * table; the shape is already the one projects need (`key`, `label`,
 * `sessionIds`).
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { GroupSource } from '../vendored/client/tree.ts'

/** How this round groups the sidebar: one active override claiming nothing. */
export const EMPTY_GROUPING: readonly GroupSource[] = Object.freeze([])

/**
 * A source that never changes, so the browser subscribes to nothing and re-renders
 * only when the Session list moves.
 *
 * `getSnapshot` returns a stable frozen array rather than a fresh `[]`: the
 * selector compares by identity, and a new array per read would re-render every
 * consumer on each store ping.
 */
export const clientGrouping: HostObservable<readonly GroupSource[] | undefined> = {
  getSnapshot: () => EMPTY_GROUPING,
  subscribe: () => () => {},
}
