/**
 * Browser entry for dsh-project-groups.
 *
 * This plugin owns the sidebar's workspace browser by **vendoring the official
 * implementation** rather than reimplementing it — see `src/vendored/README.md`
 * for why: every seam that could have let us swap behaviour underneath the
 * official component is closed by an explicit invariant, and
 * `scripts/probe-approach-b.mjs` reproduces that finding.
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
 * ## How project data reaches the browser
 *
 * This plugin owns a Remote namespace, but the Client's Remote assembly is a
 * fixed list (`packages/api/remotes/src/client/index.ts`) that does not name
 * this package — so `apply` mounts its own contribution with
 * `ctx.remote.$mount`. That is a service call, not a module import, which is why
 * it does not pull `@deepseek-ai/dsh-api-gateway/client` into this bundle.
 *
 * ## How project grouping reaches the vendored browser
 *
 * The vendored `apply` takes an optional grouping observable and threads it into
 * the browser's `grouping` hook. We pass {@link clientGrouping}; the vendored
 * half keeps its upstream default (`undefined` = group by the Host Workspace
 * registry) for the one-argument call the loader makes on any other composition.
 *
 * The override is a **parameter, not a service**: a service provided in this
 * same `apply` is not readable from this fiber until the apply has unwound, so
 * reading it during registration would race the slot declaration order.
 * `scripts/probe-service-timing.mjs` measures that.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { apply as applyVendored, inject as vendoredInject } from '../vendored/client/index.ts'
import type { ProjectActions } from '../vendored/client/index.ts'
import { clientExpansions, clientGrouping, clientOrders, installProjectModel, projectModel } from './grouping.ts'
import { ProjectModel } from './projects.ts'
import { projectGroupsRemote } from './remote.ts'
import { PROJECT_NAMESPACE } from '../protocol.ts'

export { clientExpansions, clientGrouping, clientOrders, projectModel } from './grouping.ts'
export type { GroupSource } from '../vendored/client/tree.ts'
export type { ProjectRemote } from './projects.ts'

/** The same service set the vendored half needs; see its own `inject`. */
export const inject = vendoredInject

/**
 * The verbs the browser's row menu and drag drive.
 *
 * Each resolves only after the Host has accepted the write, so a dialog awaiting
 * one closes on a committed value and a refusal surfaces in the dialog rather
 * than behind it. The state itself arrives over the `follow` stream, not from
 * these calls.
 */
const projectActions: ProjectActions = {
  createProject: async ({ title }) => { await requireModel().create(title) },
  renameProject: async (id, title) => { await requireModel().rename(id, title) },
  deleteProject: async (id) => { await requireModel().remove(id) },
  reorderProject: async (id, beforeId) => { await requireModel().reorder(id, beforeId) },
  assignSession: async (sessionId, projectId) => { await requireModel().assign(sessionId, projectId) },
  unassignSession: async (sessionId) => { await requireModel().unassign(sessionId) },
  setProjectExpanded: async (projectId, expanded) => { await requireModel().setExpanded(projectId, expanded) },
  setProjectOrders: async (orders) => { await requireModel().setOrders(orders) },
}

/** @returns the started model, or throws when the Remote namespace is absent. */
function requireModel(): ProjectModel {
  const live = projectModel()
  if (live === undefined) throw new Error('the projectGroups namespace is not available')
  return live
}

/**
 * Register the vendored browser with this plugin's grouping model.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // Mount before registering the browser so the model's baseline can land while
  // the sidebar is still being assembled. A failure here is contained: the
  // sidebar then renders one Ungrouped bucket and the project verbs refuse
  // loudly, which is better than a dead sidebar.
  void mountProjects(ctx)
  applyVendored(ctx, clientGrouping, projectActions, clientExpansions, clientOrders)
}

/**
 * Mount this plugin's Remote namespace and start the projection.
 *
 * Both services are read with `ctx.get`, not as properties: cordis gates
 * property access on the fiber's declared dependencies, so `remote.projectGroups`
 * throws `cannot get property "..." without inject`. Declaring it in `inject`
 * would deadlock — the namespace exists only because this very call mounts it, so
 * the fiber would be waiting on itself. `ctx.get` is the ungated lookup, and it
 * is what makes mounting one's own namespace possible at all
 * (`scripts/probe-inject-wait.mjs` measures both shapes).
 *
 * `$mount` is read off the `remote` service rather than imported: the gateway's
 * Client face is not a platform module, so importing it would be a build-purity
 * violation. The structural types below are the parts of those faces this plugin
 * uses.
 * @param ctx - client root context.
 */
async function mountProjects(ctx: Context): Promise<void> {
  try {
    const remote = ctx.get('remote') as {
      $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
    } | undefined
    if (remote === undefined) throw new Error('the remote service is unavailable')
    await remote.$mount(projectGroupsRemote)
    // Re-read through the ungated lookup: the mount created this service, and
    // reading it as `remote.projectGroups` would hit the inject gate.
    const namespace = ctx.get(`remote.${PROJECT_NAMESPACE}`) as
      | ConstructorParameters<typeof ProjectModel>[0]
      | undefined
    if (namespace === undefined) throw new Error(`the ${PROJECT_NAMESPACE} namespace did not mount`)
    const model = new ProjectModel(namespace)
    const stop = await model.start()
    installProjectModel(model)
    ctx.effect(() => stop, 'project-groups: follow stream')
  } catch (error: unknown) {
    console.error('dsh-project-groups: project namespace failed to mount:', error)
  }
}
