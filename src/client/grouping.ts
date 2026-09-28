/**
 * The grouping model this plugin feeds the vendored sidebar browser.
 *
 * A project is a title plus the Sessions filed under it. It is **not** a
 * Workspace: it owns no directory, contributes nothing to the Host registry, and
 * never touches a Session's `cwd`. Every Session stays in the Host's default
 * Workspace; the project is the grouping the sidebar draws on top.
 *
 * The state itself lives in the Host (`src/index.ts`, a `projectGroups` domain
 * under `$DSH_HOME/storages/`) and reaches here over this plugin's own Remote
 * namespace. {@link installProjectModel} starts the browser-side mirror.
 *
 * ## Why an override rather than the Workspace registry
 *
 * The observable is never `undefined`: `undefined` means "group by the Host
 * Workspace registry" (upstream), while an array — empty included — is an active
 * override. An install with no projects yet therefore renders one Ungrouped
 * bucket holding every Session, which is the honest picture: the feature exists
 * and nothing has been filed.
 *
 * ## Why the Host is unaffected
 *
 * Grouping is a derivation in the browser (`tree.ts` `deriveGroups`). Nothing
 * here writes Workspace membership, `cwd`, or archive state, so switching this
 * back to `undefined` — or disabling the plugin — restores the official
 * workspace-grouped sidebar with all of its data intact.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { GroupSource } from '../vendored/client/tree.ts'
import type { NewSessionTarget } from '../protocol.ts'
import type { ProjectModel } from './projects.ts'

/** The override with no projects: one Ungrouped bucket. */
const EMPTY: readonly GroupSource[] = Object.freeze([])

/** No project row has been touched yet. */
const EMPTY_EXPANSIONS: Readonly<Record<string, boolean>> = Object.freeze({})

/** No project has a recorded manual order. */
const EMPTY_ORDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({})

/**
 * The live model, or `undefined` before the Remote namespace has answered.
 *
 * Module-level because the browser's inject face is registered during `apply`
 * while the model only becomes usable once its baseline lands; both must resolve
 * the same instance.
 */
let model: ProjectModel | undefined
/** Listeners attached before the model existed, handed to it on install. */
const pending = new Set<() => void>()
/** The same, for {@link clientExpansions}; the two observables have separate seats. */
const pendingExpansions = new Set<() => void>()
/** The same, for {@link clientOrders}. */
const pendingOrders = new Set<() => void>()
/** The same, for {@link clientNewSessionTarget}. */
const pendingTargets = new Set<() => void>()

/** @returns the live model, once its baseline has landed. */
export function projectModel(): ProjectModel | undefined {
  return model
}

/**
 * Adopt the started model and wake any listeners that subscribed early.
 *
 * The browser subscribes to {@link clientGrouping} during its own registration,
 * which can precede the Remote baseline; those subscribers read an empty
 * snapshot then, and nothing would tell them the real one had arrived. They are
 * re-registered on the live model and notified once for the change in identity.
 * @param started - the started model.
 */
export function installProjectModel(started: ProjectModel): void {
  model = started
  const early = [...pending]
  pending.clear()
  for (const notify of early) started.grouping.subscribe(notify)
  // The snapshot these listeners last read was the empty override; the model now
  // has the Host's, so one notification is a real change rather than a no-op.
  for (const notify of early) notify()

  const earlyExpansions = [...pendingExpansions]
  pendingExpansions.clear()
  for (const notify of earlyExpansions) started.expansions.subscribe(notify)
  for (const notify of earlyExpansions) notify()

  const earlyOrders = [...pendingOrders]
  pendingOrders.clear()
  for (const notify of earlyOrders) started.orders.subscribe(notify)
  for (const notify of earlyOrders) notify()

  const earlyTargets = [...pendingTargets]
  pendingTargets.clear()
  for (const notify of earlyTargets) started.newSessionTarget$.subscribe(notify)
  for (const notify of earlyTargets) notify()
}

/**
 * The observable handed to the vendored browser.
 *
 * Reads through the module-level model so the browser may register before the
 * Remote namespace is ready: until the first baseline lands the snapshot is an
 * empty override, which renders exactly what a fresh install looks like.
 */
export const clientGrouping: HostObservable<readonly GroupSource[] | undefined> = {
  getSnapshot: () => model?.grouping.getSnapshot() ?? EMPTY,
  subscribe: (listener) => {
    const live = model
    if (live === undefined) {
      pending.add(listener)
      return () => { pending.delete(listener) }
    }
    return live.grouping.subscribe(listener)
  },
}

/**
 * The recorded expansion of each project row, handed to the vendored browser.
 *
 * A separate observable from {@link clientGrouping} because it is a separate
 * seat in the inject face: the region reads it with its own hook. It carries the
 * plugin's own Host state rather than the browser's view store, which the
 * official plugin shares and prunes — see `src/vendored/README.md`.
 */
export const clientExpansions: HostObservable<Readonly<Record<string, boolean>>> = {
  getSnapshot: () => model?.expansions.getSnapshot() ?? EMPTY_EXPANSIONS,
  subscribe: (listener) => {
    const live = model
    if (live === undefined) {
      pendingExpansions.add(listener)
      return () => { pendingExpansions.delete(listener) }
    }
    return live.expansions.subscribe(listener)
  },
}

/**
 * The recorded manual order of each project's members, handed to the vendored
 * browser.
 *
 * Its own seat, for the same reason as {@link clientExpansions}: the region reads
 * it with its own hook, and it carries the plugin's Host state rather than the
 * view store the official plugin shares and prunes.
 */
export const clientOrders: HostObservable<Readonly<Record<string, readonly string[]>>> = {
  getSnapshot: () => model?.orders.getSnapshot() ?? EMPTY_ORDERS,
  subscribe: (listener) => {
    const live = model
    if (live === undefined) {
      pendingOrders.add(listener)
      return () => { pendingOrders.delete(listener) }
    }
    return live.orders.subscribe(listener)
  },
}

/**
 * The stored New Session destination, for this plugin's own settings card.
 *
 * Its own seat rather than a read of {@link projectModel} at render time: the
 * card can register before the Remote baseline lands, and it must follow later
 * changes (the optimistic write, and the Host's `follow` frame) like every other
 * observable here.
 *
 * Deliberately **not** handed to the vendored browser. That half renders groups
 * and has no business knowing where an unscoped New Session goes; the choice is
 * spent in `index.ts` when a Session actually lands, so only the settings card
 * needs to read it.
 *
 * Before the model exists the snapshot is `'ungrouped'`, matching
 * `EMPTY_STATE.newSessionTarget` and the Host's own default — so the card shows
 * the value a fresh install would actually use rather than a blank.
 */
export const clientNewSessionTarget: HostObservable<NewSessionTarget> = {
  getSnapshot: () => model?.target() ?? 'ungrouped',
  subscribe: (listener) => {
    const live = model
    if (live === undefined) {
      pendingTargets.add(listener)
      return () => { pendingTargets.delete(listener) }
    }
    return live.newSessionTarget$.subscribe(listener)
  },
}
