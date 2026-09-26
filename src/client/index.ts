/**
 * Browser entry for dsh-project-groups.
 *
 * This plugin owns the sidebar's workspace browser by **vendoring the official
 * implementation** rather than reimplementing it — see
 * `src/vendored/README.md` for why: every seam that could have let us swap
 * behaviour underneath the official component is closed by an explicit
 * invariant, and `scripts/probe-approach-b.mjs` reproduces that finding.
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
 *
 * ## How project grouping reaches the vendored browser
 *
 * The vendored `apply` takes an optional grouping observable and threads it
 * into the browser's `grouping` hook. We pass {@link clientGrouping}; the
 * vendored half keeps its upstream default (`undefined` = group by the Host
 * Workspace registry) for the one-argument call the loader makes on any other
 * composition.
 *
 * The override is a **parameter, not a service**: a service provided in this
 * same `apply` is not readable from this fiber until the apply has unwound, so
 * reading it during registration would race the slot declaration order.
 * `scripts/probe-service-timing.mjs` measures that; the parameter makes the
 * order explicit and unobservable at runtime.
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyVendored, inject as vendoredInject } from '../vendored/client/index.ts'
import { clientGrouping, projects } from './grouping.ts'
import type { ProjectActions } from '../vendored/client/index.ts'

export { clientGrouping, projects } from './grouping.ts'
export type { GroupSource } from '../vendored/client/tree.ts'
export type { Project } from './projects.ts'

/** The same service set the vendored half needs; see its own `inject`. */
export const inject = vendoredInject

/**
 * The verbs the browser row menu and drag drive, bound to this plugin's model.
 *
 * Each resolves only after the model has changed, so the dialog that awaited it
 * closes on a committed value and a rejection surfaces in the dialog rather
 * than behind it.
 */
const projectActions: ProjectActions = {
  createProject: async ({ title }) => { projects.create(title) },
  renameProject: async (id, title) => {
    if (!projects.rename(id, title)) throw new Error(`unknown project: ${id}`)
  },
  deleteProject: async (id) => {
    if (!projects.delete(id)) throw new Error(`unknown project: ${id}`)
  },
  reorderProject: async (id, beforeId) => { projects.reorder(id, beforeId) },
}

/**
 * Register the vendored browser with this plugin's grouping model.
 *
 * The grouping override is a parameter rather than a service: a service
 * provided in this same apply is not readable from this fiber until the apply
 * has unwound, so reading one during registration would race the slot
 * declaration order (`scripts/probe-service-timing.mjs` measures that).
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  applyVendored(ctx, clientGrouping, projectActions)
}

