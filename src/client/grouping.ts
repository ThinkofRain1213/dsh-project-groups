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
import type { BaseWorkspaceSetting, NewSessionTarget } from '../protocol.ts'
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
/** The same, for {@link clientBaseWorkspace}. */
const pendingBase = new Set<() => void>()
/** The same, for {@link clientCreateOpensSession}. */
const pendingCreateOpens = new Set<() => void>()
/** The same, for {@link clientInjectProjectInfo}. */
const pendingInjectInfo = new Set<() => void>()
/** The same, for {@link clientInjectProjectDoc}. */
const pendingInjectDoc = new Set<() => void>()

/** The empty spec list, shared so the pre-model snapshot is identity-stable. */
const EMPTY_SPECS: readonly string[] = Object.freeze([])

/**
 * Seats built by {@link pendingSeat}, each of which knows how to re-register
 * itself once the model exists.
 *
 * The named `pending*` sets above predate this and are kept as they are: they
 * carry per-seat comments explaining their own lifecycle, and rewriting working
 * code to use the new helper would be churn without a behaviour change.
 */
const installHooks: ((live: ProjectModel) => void)[] = []

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
  // The helper-built seats first: each re-registers its own early subscribers.
  for (const install of installHooks) install(started)
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

  const earlyBase = [...pendingBase]
  pendingBase.clear()
  for (const notify of earlyBase) started.baseWorkspace$.subscribe(notify)
  for (const notify of earlyBase) notify()

  const earlyCreateOpens = [...pendingCreateOpens]
  pendingCreateOpens.clear()
  for (const notify of earlyCreateOpens) started.createOpensSession$.subscribe(notify)
  for (const notify of earlyCreateOpens) notify()

  const earlyInjectInfo = [...pendingInjectInfo]
  pendingInjectInfo.clear()
  for (const notify of earlyInjectInfo) started.injectProjectInfo$.subscribe(notify)
  for (const notify of earlyInjectInfo) notify()

  const earlyInjectDoc = [...pendingInjectDoc]
  pendingInjectDoc.clear()
  for (const notify of earlyInjectDoc) started.injectProjectDoc$.subscribe(notify)
  for (const notify of earlyInjectDoc) notify()
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

/** The base-workspace setting a fresh install uses: the official default Workspace. */
const DEFAULT_BASE_WORKSPACE: BaseWorkspaceSetting = Object.freeze({ mode: 'default' })

/**
 * The stored base workspace, for this plugin's own settings card.
 *
 * Its own seat, for the same reason as {@link clientNewSessionTarget}: the card can
 * register before the Remote baseline lands, and it must follow later changes (the
 * optimistic write, and the Host's `follow` frame).
 *
 * Deliberately **not** handed to the vendored browser: that half renders groups, and
 * the setting is spent elsewhere — by the card that writes it, and by the resolver
 * that chooses where a New Session lands.
 *
 * Before the model exists the snapshot is `{ mode: 'default' }`, which is both what
 * `EMPTY_STATE` carries and what the Host defaults to — so the card shows the value a
 * fresh install would actually use rather than a blank.
 */
export const clientBaseWorkspace: HostObservable<BaseWorkspaceSetting> = {
  getSnapshot: () => model?.baseWorkspaceSetting() ?? DEFAULT_BASE_WORKSPACE,
  subscribe: (listener) => {
    const live = model
    if (live === undefined) {
      pendingBase.add(listener)
      return () => { pendingBase.delete(listener) }
    }
    return live.baseWorkspace$.subscribe(listener)
  },
}

/**
 * Whether creating a project opens a Session, handed to the vendored browser **and**
 * read by the settings card.
 *
 * Unlike {@link clientNewSessionTarget} and {@link clientBaseWorkspace}, this seat
 * **is** given to the vendor tree: the create dialog lives there, so that half is
 * where the value is spent, and it cannot read the plugin's own model. The card reads
 * the same observable, which is what keeps one switch driving the behaviour the user
 * then sees.
 *
 * Before the model exists the snapshot is `true`, matching `EMPTY_STATE` and the
 * Host's default — so a fresh install shows the behaviour it would actually get.
 */
export const clientCreateOpensSession: HostObservable<boolean> = {
  getSnapshot: () => model?.createOpensSessionValue() ?? true,
  subscribe: (listener) => {
    const live = model
    if (live === undefined) {
      pendingCreateOpens.add(listener)
      return () => { pendingCreateOpens.delete(listener) }
    }
    return live.createOpensSession$.subscribe(listener)
  },
}

/**
 * Whether a Session's project info is injected, read by the settings card.
 *
 * Not given to the vendor tree: the injection happens on the Host, at request
 * time, and the sidebar renders groups rather than model context. This seat
 * exists so the card's switch reflects the stored value rather than the click.
 *
 * Before the model exists the snapshot is `true`, matching `EMPTY_STATE` and the
 * Host's schema default — a fresh install shows the behaviour it would get.
 */
export const clientInjectProjectInfo: HostObservable<boolean> = {
  getSnapshot: () => model?.injectProjectInfoValue() ?? true,
  subscribe: (listener) => {
    const live = model
    if (live === undefined) {
      pendingInjectInfo.add(listener)
      return () => { pendingInjectInfo.delete(listener) }
    }
    return live.injectProjectInfo$.subscribe(listener)
  },
}

/**
 * Whether the work-document line is injected too, read by the settings card.
 *
 * Its own seat rather than a derived value: the two switches are independent in
 * the domain, and the card renders them as separate rows — folding them here
 * would make the card unable to show one as the master and the other as gated.
 *
 * Before the model exists the snapshot is `false`, matching `EMPTY_STATE` and the
 * Host's schema default: the document is the extra feature, so it starts off.
 */
export const clientInjectProjectDoc: HostObservable<boolean> = {
  getSnapshot: () => model?.injectProjectDocValue() ?? false,
  subscribe: (listener) => {
    const live = model
    if (live === undefined) {
      pendingInjectDoc.add(listener)
      return () => { pendingInjectDoc.delete(listener) }
    }
    return live.injectProjectDoc$.subscribe(listener)
  },
}

/**
 * Build a seat for one scalar the settings card reads.
 *
 * The five new document-spec values share a shape exactly: read through the
 * module-level model, fall back to a stated snapshot before it exists, and
 * re-seat subscribers once it does. Writing that out five times would be five
 * copies of one rule, so it is built once — the per-seat differences are the
 * three arguments.
 * @param read - resolves the value from the live model.
 * @param fallback - the snapshot served before the model exists.
 * @param seat - picks that value's observable from the live model.
 * @returns the observable handed to the settings card.
 */
function pendingSeat<T>(
  read: (live: ProjectModel) => T,
  fallback: T,
  seat: (live: ProjectModel) => HostObservable<T>,
): HostObservable<T> {
  const early = new Set<() => void>()
  // The listener set is registered against the live model on install; until
  // then a subscriber waits here, which is what keeps a card that mounted
  // before the baseline from reading a stale snapshot forever.
  installHooks.push((live) => {
    const waiting = [...early]
    early.clear()
    for (const notify of waiting) seat(live).subscribe(notify)
    for (const notify of waiting) notify()
  })
  return {
    getSnapshot: () => model === undefined ? fallback : read(model),
    subscribe: (listener) => {
      const live = model
      if (live === undefined) {
        early.add(listener)
        return () => { early.delete(listener) }
      }
      return seat(live).subscribe(listener)
    },
  }
}

/**
 * Which spec source applies before any project override.
 *
 * Before the model exists the snapshot is `'default'`, matching `EMPTY_STATE`
 * and the Host's schema default: a fresh install follows the built-in spec.
 */
export const clientDocSpecMode: HostObservable<'none' | 'default' | 'custom'> = pendingSeat(
  live => live.docSpecModeValue(),
  'default',
  live => live.docSpecMode$,
)

/** The uploaded spec `'custom'` names; `''` when the user has not chosen one. */
export const clientDocSpecFileName: HostObservable<string> = pendingSeat(
  live => live.docSpecFileNameValue(),
  '',
  live => live.docSpecFileName$,
)

/** Whether the project dialogs expose a per-project spec row. */
export const clientPerProjectDocSpec: HostObservable<boolean> = pendingSeat(
  live => live.perProjectDocSpecValue(),
  false,
  live => live.perProjectDocSpec$,
)

/** Every uploaded spec's file name, sorted. */
export const clientSpecs: HostObservable<readonly string[]> = pendingSeat(
  live => live.specsValue(),
  EMPTY_SPECS,
  live => live.specs$,
)
