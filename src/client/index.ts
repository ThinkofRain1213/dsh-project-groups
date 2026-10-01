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
// Type-only: pulls the Plugin manager's SlotMap merge (the
// 'plugins.bundle.config' entry). Collaborating through a slot, never a value.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { apply as applyVendored, inject as vendoredInject } from '../vendored/client/index.ts'
import type { ProjectActions } from '../vendored/client/index.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  clientBaseWorkspace, clientCreateOpensSession, clientExpansions, clientGrouping,
  clientNewSessionTarget, clientOrders,
  installProjectModel, projectModel,
} from './grouping.ts'
import { ProjectModel } from './projects.ts'
import { recentDestination, resolveTarget } from './target.ts'
import { projectGroupsRemote } from './remote.ts'
import { ProjectGroupsCard } from './settings-card.tsx'
import { en, SETTINGS_NS, zh } from './settings-locales.ts'
import { PROJECT_NAMESPACE } from '../protocol.ts'
import type { BaseWorkspaceSetting, NewSessionTarget } from '../protocol.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export { clientExpansions, clientGrouping, clientNewSessionTarget, clientOrders, projectModel } from './grouping.ts'
export { clientBaseWorkspace } from './grouping.ts'
export type { GroupSource } from '../vendored/client/tree.ts'
export type { ProjectRemote } from './projects.ts'

/** The same service set the vendored half needs; see its own `inject`. */
export const inject = vendoredInject

/**
 * The Workspace registry snapshot, captured by {@link apply}.
 *
 * Module-level like the model itself, because {@link projectActions} is built at module
 * load while the service only exists once `apply` runs. `resolveBaseWorkspace` needs it to
 * turn the setting's stored **path** into a Workspace id.
 */
let workspacesRegistry: WorkspaceSource | undefined

/**
 * The root context, captured by {@link apply}.
 *
 * {@link projectActions} is built at module load while the context only exists once `apply`
 * runs, so the verbs that need an ungated `ctx.get` read it from here. Ungated on purpose for
 * `pluginNavigation`, which the manager disposes with its page slot.
 */
let clientContext: Context | undefined

/**
 * A request to open the base-workspace chooser, raised by the missing-workspace dialog and
 * consumed by the settings card.
 *
 * An object rather than a boolean: a **repeat** request has to be a new value to be observable,
 * and a value left at `true` cannot change. The card consumes it by setting `null`, so the value
 * only ever alternates and never accumulates. Same shape, and the same reason, as the vendored
 * half's own `baseWorkspaceRequest`.
 */
const chooserRequest = createSnapshotStore<BaseWorkspaceChooserRequest | null>(null)

/** The request the chooser store carries; see {@link chooserRequest}. */
export interface BaseWorkspaceChooserRequest {
  /** Which behaviour is wanted. Only `'pick'` exists: open the chooser on the settings card. */
  readonly kind: 'pick'
}

/**
 * The verbs the browser's row menu and drag drive.
 *
 * Each resolves only after the Host has accepted the write, so a dialog awaiting
 * one closes on a committed value and a refusal surfaces in the dialog rather
 * than behind it. The state itself arrives over the `follow` stream, not from
 * these calls.
 */
const projectActions: ProjectActions = {
  createProject: async ({ title }) => ({ projectId: await requireModel().create(title) }),
  renameProject: async (id, title) => { await requireModel().rename(id, title) },
  deleteProject: async (id) => { await requireModel().remove(id) },
  reorderProject: async (id, beforeId) => { await requireModel().reorder(id, beforeId) },
  assignSession: async (sessionId, projectId) => { await requireModel().assign(sessionId, projectId) },
  unassignSession: async (sessionId) => { await requireModel().unassign(sessionId) },
  setProjectExpanded: async (projectId, expanded) => { await requireModel().setExpanded(projectId, expanded) },
  setProjectOrders: async (orders) => { await requireModel().setOrders(orders) },
  placeUnscopedSession: ({ sessionId, currentSessionId, updatedAt }) => {
    // Not `requireModel`: this runs on a New Session click, and a missing model
    // must leave the Session where the navigation put it rather than throw out
    // of a navigation callback. Ungrouped is the outcome either way, which is
    // also what the caller's default resolves to.
    const model = projectModel()
    if (model === undefined) return
    const projectId = resolveTarget(
      model.target(),
      currentSessionId,
      id => model.projectOf(id),
      () => recentDestination(
        model.list(),
        updatedAt,
        id => model.membersOf(id),
        // Ungrouped is a candidate too, so it needs its members. The activity map
        // holds every Session with real activity, and its keys minus the filed
        // ones are exactly the Sessions in no project. Sessions the model has
        // never heard of are loose by this definition, which is correct: this
        // plugin files nothing anywhere else.
        //
        // The cast follows `projects.ts`: `Object.keys` widens to `string`, while
        // the map is keyed by the branded id it was built from.
        Object.keys(updatedAt).filter(id => model.projectOf(id as SessionId) === undefined),
      ),
    )
    // A Session with no project has no assignment record — that absence is what
    // "Ungrouped" means, so it is a delete rather than a write.
    const placement = projectId === undefined
      ? model.unassign(sessionId)
      : model.assign(sessionId, projectId)
    void placement.catch((reason: unknown) => {
      // Logged rather than surfaced, like the row's own filing: the Session was
      // created and opened, so a placement failure must not read as a failed New
      // Session.
      console.warn('place new session rejected:', reason)
    })
  },
  defaultWorkspacePath: async () => {
    // `projectModel`, not `requireModel`: this labels a dialog, and a model that has
    // not started yet must leave the label reading "unknown" rather than throw out
    // of the relay. Null is that same outcome.
    const model = projectModel()
    if (model === undefined) return null
    return await model.defaultWorkspacePath()
  },
  // `rebuildBaseWorkspace` is wired below by step 3b.
  rebuildBaseWorkspace: async () => {
    // `requireModel`, not the guarded read used by the other verbs: the dialog's runner catches a
    // rejection and shows it, so a model that has not started must surface as an error there rather
    // than silently do nothing — the user asked for a directory to be created.
    await requireModel().rebuildBaseWorkspace()
  },
  chooseBaseWorkspace: () => {
    // `ctx.get`, not the property read. The manager publishes this service from **inside its
    // page slot** and disposes it with that slot (measured: `ctx.reflect.provide` followed by a
    // `yield` disposer, a couple of hundred characters inside a `slots.register` body), so
    // declaring it in `inject` would gate the whole plugin on a service that comes and goes —
    // projects, grouping and persistence would die with the Plugins page. The official
    // voice-input plugin's `inject: ['pluginNavigation']` is a sub-fiber
    // (`ctx.inject([...], registerUi)`), not a pattern that transfers to a plugin that must work
    // without the manager.
    const navigation = clientContext?.get('pluginNavigation') as
      | { openBundle: (name: string) => void }
      | undefined
    // One call does both halves — measured from a third-party fiber: `selectPanel('plugins')`
    // then `setView({ kind: 'package', name })`, which mounts our card. Optional-chained so a
    // composition without the manager still opens the chooser by the store alone: the card
    // reads it wherever it is, and if the user is already on the Plugins page no navigation
    // was needed anyway.
    navigation?.openBundle('dsh-project-groups')
    // Written **after** the navigation request. The card may not be mounted yet, which is
    // fine — a snapshot read returns live state, so a card that mounts later still sees it.
    chooserRequest.set({ kind: 'pick' })
  },
  resolveBaseWorkspace: () => {
    const model = projectModel()
    // No model yet — the Remote baseline has not landed — means the shipped flow,
    // **not** a report. `mountProjects` is fire-and-forget, so a New Session click
    // during boot is a real sequence, and reporting a missing Workspace before
    // anything is known would be a false alarm on every cold start.
    if (model === undefined) return { kind: 'official' as const }
    const setting = model.baseWorkspaceSetting()
    if (setting.mode !== 'specified') return { kind: 'official' as const }
    const path = setting.path ?? ''
    // A `'specified'` setting with no path cannot be produced through the Host (it
    // refuses that write), but a hand-edited medium could hold one. Read as "unset"
    // rather than "missing": there is nothing to report and no id to resolve.
    if (path === '') return { kind: 'official' as const }
    // Resolved by **path**, never by id: re-registering a directory mints a new id
    // (measured), so a stored id would go stale while the path keeps resolving. That
    // is also what lets a delete-and-re-add at the same path re-adopt itself.
    const items = workspacesRegistry?.getSnapshot().items ?? []
    const found = items.find(item => item.path === path)
    return found === undefined
      ? { kind: 'missing' as const, path, name: setting.name ?? null }
      : { kind: 'workspace' as const, workspaceId: found.workspaceId }
  },
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
  // Read once, like the settings card does: this plugin's client inject list names the
  // Workspace controller, and `ctx.get` is the ungated lookup.
  workspacesRegistry = (ctx.get('workspaces') as { list: WorkspaceSource } | undefined)?.list
  clientContext = ctx
  // Mount before registering the browser so the model's baseline can land while
  // the sidebar is still being assembled. A failure here is contained: the
  // sidebar then renders one Ungrouped bucket and the project verbs refuse
  // loudly, which is better than a dead sidebar.
  void mountProjects(ctx)
  applyVendored(
    ctx, clientGrouping, projectActions, clientExpansions, clientOrders, clientCreateOpensSession,
  )
  registerSettingsCard(ctx)
}

/**
 * Contribute this plugin's configuration card to its own Plugin manager page.
 *
 * The `key` must be this bundle's package name: the page dispatches the keyed
 * slot by it, and that same key is what makes the page render the section at all
 * (`config-ledger.ts` projects `plugins.bundle.config`'s keys into the
 * `configured` flag). A key that does not match the installed bundle name is
 * silently not rendered, which is why `probe-settings-card.mjs` asserts the card
 * is present rather than trusting the registration.
 *
 * `slots.inject` waits for the Plugins page to declare the slot, so this needs no
 * ordering assumption and both sides leave together.
 * @param ctx - client root context.
 */
function registerSettingsCard(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'project-groups: settings dictionaries')
  // `ctx.get`, not a property read: cordis gates property access on the fiber's own
  // declared depends, and this fiber injects the vendored half's service list rather
  // than the Workspace controller by name.
  const workspaces = ctx.get('workspaces') as { list: WorkspaceSource } | undefined
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: 'dsh-project-groups',
    locale: SETTINGS_NS,
    inject: () => ({
      hooks: {
        target: clientNewSessionTarget,
        baseWorkspace: clientBaseWorkspace,
        createOpensSession: clientCreateOpensSession,
        // Spread rather than assigned as `undefined`: the hooks compartment holds
        // observables, and a present-but-undefined key would break the renderer's
        // binding. Absent, the chooser reports "暂无工作区".
        ...(workspaces === undefined ? {} : { workspaces: workspaces.list }),
        // The dialog's "open the chooser" request. A hook rather than a prop because the
        // request arrives while the card may not be mounted yet: the card reads the store on
        // first render, so a request written before it mounted is not lost.
        chooserRequest,
      },
      settleBaseWorkspaceChooser: () => { chooserRequest.set(null) },
      setTarget: (target: NewSessionTarget) => {
        // Not `requireModel`: the card can render before the Remote baseline
        // lands, and a click then must be a no-op rather than a thrown error out
        // of a React event handler. The optimistic write inside the model is
        // what makes the card follow the choice immediately.
        const live = projectModel()
        if (live === undefined) return
        void live.setNewSessionTarget(target).catch((reason: unknown) => {
          console.warn('set new session target rejected:', reason)
        })
      },
      setBaseWorkspace: (setting: BaseWorkspaceSetting) => {
        // Same reasoning as `setTarget`, and the same optimistic write behind it.
        const live = projectModel()
        if (live === undefined) return
        void live.setBaseWorkspace(setting).catch((reason: unknown) => {
          console.warn('set base workspace rejected:', reason)
        })
      },
      setCreateOpensSession: (value: boolean) => {
        // Same reasoning again: the card can render before the baseline lands, and a
        // click then must be a no-op rather than a thrown error out of a React event
        // handler. The optimistic write inside the model is what makes the switch
        // follow the click immediately.
        const live = projectModel()
        if (live === undefined) return
        void live.setCreateOpensSession(value).catch((reason: unknown) => {
          console.warn('set create-opens-session rejected:', reason)
        })
      },
    }),
  }, ProjectGroupsCard))
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
