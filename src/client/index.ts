/**
 * Browser entry for dsh-project-groups.
 *
 * This plugin owns the sidebar's workspace browser by **vendoring the official
 * implementation** rather than reimplementing it — see
 * `src/vendored/README.md` for why: every seam that could have let us swap
 * behaviour underneath the official component is closed by an explicit
 * invariant, and `scripts/probe-approach-b.mjs` reproduces that finding.
 *
 * This round deliberately changes **no behaviour**. The re-export below is the
 * seam where project-group logic lands next, so the vendored tree stays a clean
 * copy that can be re-synced against upstream.
 *
 * Runtime identity is unchanged from the official plugin:
 *
 *  - the same `sidebar.workspaces` slot is claimed, so the sidebar shell and its
 *    session row actions keep working;
 *  - the same `uiWorkspace` service is provided — the sidebar shell and the
 *    directory pickers inject it, so without it the whole sidebar fails to load;
 *  - the same `workspaces` root hook is provided.
 *
 * The official `@deepseek-ai/dsh-client-ui-workspace` row is disabled by this
 * plugin's `cordis.patch.yml`: two claimants of the single slot, or two
 * providers of those services, would be a hard startup error rather than a
 * merge.
 */

export { apply, inject } from '../vendored/client/index.ts'
