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
import type { InjectionLocale } from '../injection.ts'
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

/** The empty spec list, shared so the pre-model snapshot is identity-stable. */
const EMPTY_SPECS: readonly string[] = Object.freeze([])

/** Each seat's re-registration step, run once the model exists. */
const installHooks: ((live: ProjectModel) => void)[] = []

/**
 * Call every listener, isolating a failure to the listener that caused it.
 *
 * These callbacks are arbitrary external subscribers — React components, the vendored
 * browser's selectors — so one of them throwing is possible and must not be contagious.
 * Without isolation a single throw aborted the loop: every *later* listener went
 * un-notified for what may be a real state change, and in `installProjectModel`'s case the
 * remaining seats were never wired at all, leaving them parked forever.
 *
 * Logged rather than rethrown: the caller here is an install or a state transition with no
 * useful recovery, and turning one subscriber's bug into a broken sidebar is worse than
 * losing that subscriber's update.
 * @param listeners - the callbacks to invoke, in order.
 */
function notifyAll(listeners: readonly (() => void)[]): void {
  for (const notify of listeners) {
    try {
      notify()
    } catch (error: unknown) {
      console.warn('dsh-project-groups: an observable listener threw', error)
    }
  }
}

/**
 * Build one seat that may be subscribed to before the model exists.
 *
 * ## Why every subscribe has to be cancellable after the re-seat
 *
 * A subscriber that arrives early is parked in `early`; when the baseline lands
 * the seat attaches it to the live model. That attachment returns its own
 * unsubscribe, and the returned disposer must reach **it** — not just the parked
 * entry. Discarding it made the disposer stop detaching anything the moment the
 * model arrived: the caller's `cancel()` removed an entry from a set that had
 * already been cleared, while the listener stayed attached to the live
 * observable for the lifetime of the page.
 *
 * That is a listener leak with a visible symptom beyond memory: a React
 * component that subscribed before the baseline and later unmounted kept being
 * notified, so it re-rendered after unmount.
 *
 * `liveOff` holds the current unsubscribe for every listener that was re-seated,
 * and the disposer cancels whichever registration is live — parked or attached.
 * @param read - resolves the value, from the model when there is one.
 * @param attach - registers a listener on the live model, returning its unsubscribe.
 * @returns the observable handed to the browser or the settings card.
 */
function deferredSeat<T>(
  read: (live: ProjectModel | undefined) => T,
  attach: (live: ProjectModel, listener: () => void) => () => void,
): HostObservable<T> {
  const early = new Set<() => void>()
  const liveOff = new Map<() => void, () => void>()
  installHooks.push((live) => {
    const waiting = [...early]
    early.clear()
    // Each subscription is isolated too: a seat whose `attach` throws must not stop the
    // remaining listeners from being wired, which would leave them parked despite the model
    // having arrived.
    for (const notify of waiting) {
      try {
        liveOff.set(notify, attach(live, notify))
      } catch (error: unknown) {
        console.warn('dsh-project-groups: failed to re-seat a listener', error)
      }
    }
    // The snapshot these listeners last read was the empty/pre-model one; the
    // model now has the Host's, so one notification is a real change.
    notifyAll(waiting)
  })
  return {
    getSnapshot: () => read(model),
    subscribe: (listener) => {
      const live = model
      if (live !== undefined) return attach(live, listener)
      early.add(listener)
      return () => {
        early.delete(listener)
        const off = liveOff.get(listener)
        if (off !== undefined) {
          liveOff.delete(listener)
          off()
        }
      }
    },
  }
}

/** @returns the live model, once its baseline has landed. */
export function projectModel(): ProjectModel | undefined {
  return model
}

/**
 * Adopt the started model and wake any listeners that subscribed early.
 *
 * The browser subscribes to {@link clientGrouping} during its own registration,
 * which can precede the Remote baseline; those subscribers read an empty
 * snapshot then, and nothing would tell them the real one had arrived. Each seat
 * re-registers its own early subscribers — see {@link deferredSeat}.
 * @param started - the started model.
 */
export function installProjectModel(started: ProjectModel): void {
  model = started
  // One hook throwing must not skip the remaining seats.
  //
  // These are the module's own re-seat steps, but they run caller-supplied listeners
  // (through `attach` and the notify pass), so a subscriber's bug could otherwise abort this
  // loop and leave every later seat parked forever — its subscribers waiting for a model
  // that had already arrived.
  for (const install of installHooks) {
    try {
      install(started)
    } catch (error: unknown) {
      console.warn('dsh-project-groups: a seat failed to install', error)
    }
  }
  // The hooks are one-shot: they exist to move parked subscribers onto the first model, and
  // that has now happened. Keeping them meant a second `installProjectModel` call would
  // re-run all of them and the array grew for the process's life; clearing them makes the
  // single-invocation contract structural rather than a comment. (A re-install after a
  // teardown re-registers its own hooks through the seats' own `subscribe`, so nothing is
  // lost — those seats rebuild their parking sets on the next early subscribe.)
  installHooks.length = 0
}

/**
 * The observable handed to the vendored browser.
 *
 * Reads through the module-level model so the browser may register before the
 * Remote namespace is ready: until the first baseline lands the snapshot is an
 * empty override, which renders exactly what a fresh install looks like.
 */
export const clientGrouping: HostObservable<readonly GroupSource[] | undefined> = deferredSeat(
  live => live?.grouping.getSnapshot() ?? EMPTY,
  (live, listener) => live.grouping.subscribe(listener),
)

/**
 * The recorded expansion of each project row, handed to the vendored browser.
 *
 * A separate observable from {@link clientGrouping} because it is a separate
 * seat in the inject face: the region reads it with its own hook. It carries the
 * plugin's own Host state rather than the browser's view store, which the
 * official plugin shares and prunes — see `src/vendored/README.md`.
 */
export const clientExpansions: HostObservable<Readonly<Record<string, boolean>>> = deferredSeat(
  live => live?.expansions.getSnapshot() ?? EMPTY_EXPANSIONS,
  (live, listener) => live.expansions.subscribe(listener),
)

/**
 * The recorded manual order of each project's members, handed to the vendored
 * browser.
 *
 * Its own seat, for the same reason as {@link clientExpansions}: the region reads
 * it with its own hook, and it carries the plugin's Host state rather than the
 * view store the official plugin shares and prunes.
 */
export const clientOrders: HostObservable<Readonly<Record<string, readonly string[]>>> = deferredSeat(
  live => live?.orders.getSnapshot() ?? EMPTY_ORDERS,
  (live, listener) => live.orders.subscribe(listener),
)

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
export const clientNewSessionTarget: HostObservable<NewSessionTarget> = deferredSeat(
  live => live?.target() ?? 'ungrouped',
  (live, listener) => live.newSessionTarget$.subscribe(listener),
)

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
export const clientBaseWorkspace: HostObservable<BaseWorkspaceSetting> = deferredSeat(
  live => live?.baseWorkspaceSetting() ?? DEFAULT_BASE_WORKSPACE,
  (live, listener) => live.baseWorkspace$.subscribe(listener),
)

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
export const clientCreateOpensSession: HostObservable<boolean> = deferredSeat(
  live => live?.createOpensSessionValue() ?? true,
  (live, listener) => live.createOpensSession$.subscribe(listener),
)

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
export const clientInjectProjectInfo: HostObservable<boolean> = deferredSeat(
  live => live?.injectProjectInfoValue() ?? true,
  (live, listener) => live.injectProjectInfo$.subscribe(listener),
)

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
export const clientInjectProjectDoc: HostObservable<boolean> = deferredSeat(
  live => live?.injectProjectDocValue() ?? false,
  (live, listener) => live.injectProjectDoc$.subscribe(listener),
)

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
  return deferredSeat(
    live => live === undefined ? fallback : read(live),
    (live, listener) => seat(live).subscribe(listener),
  )
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

/**
 * Whether the project dialogs mark links that are not `http(s)://` URLs.
 *
 * Given to the vendored tree **and** read by the settings card: the marking happens in
 * the dialog, which cannot see this model, and the card's switch must show the same value
 * the dialog acts on.
 *
 * Before the model exists the snapshot is `true`, matching `EMPTY_STATE` and the Host's
 * schema default — a fresh install marks, which is the behaviour it is about to get.
 */
export const clientValidateLinks: HostObservable<boolean> = pendingSeat(
  live => live.validateLinksValue(),
  true,
  live => live.validateLinks$,
)

/** Every uploaded spec's file name, sorted. */
export const clientSpecs: HostObservable<readonly string[]> = pendingSeat(
  live => live.specsValue(),
  EMPTY_SPECS,
  live => live.specs$,
)

/**
 * The slice of the locale service this plugin reads.
 *
 * Structural rather than the service's own type: these two members are exactly what the observable
 * below needs, and naming only those keeps this plugin's compile surface from growing with a
 * service it otherwise does not touch.
 */
interface LocaleServiceLike {
  readonly getSnapshot: () => { readonly active: string }
  readonly subscribe: (listener: () => void) => () => void
}

/**
 * The locale service, captured by {@link installLocaleService}.
 *
 * Module-level like {@link model}, and for the same reason: the observable is built at module load
 * while the service only exists once the client's `apply` runs.
 */
let localeService: LocaleServiceLike | undefined

/** Listeners parked before the locale service arrived. */
const pendingLocale = new Set<() => void>()
/** The live locale subscription for each re-seated listener, so disposal reaches it. */
const localeLiveOff = new Map<() => void, () => void>()

/**
 * Normalize an active locale id to the two languages this plugin renders user-facing text for.
 *
 * The rule matches the Host's normalization of the **stored preference** — English is recognized
 * and everything else is Chinese — but the test differs, deliberately. The Host reads a preference
 * written as `'en'`, while the browser's snapshot carries a **resolved BCP 47 id** that may be
 * `'en-US'`; hence `startsWith`. A drift question previewed in the wrong language would make the
 * injection preview state something the injected block does not do.
 * @param active - the active locale id.
 * @returns the locale to render the drift question in.
 */
function injectionLocaleOf(active: string): InjectionLocale {
  return active.startsWith('en') ? 'en' : 'zh'
}

/**
 * Adopt the locale service, once the client's `apply` has it.
 *
 * Early subscribers are re-seated here, matching the contract every other seat in
 * this module follows. Without it a card that mounted before `apply` — which is the
 * normal case, since the service is only captured then — registered its listener
 * nowhere: `getSnapshot` would later read the right value, but nothing would ever
 * notify the component, so it could sit on the `'zh'` fallback indefinitely while the
 * Host had already resolved `'en'`.
 * @param service - the live service, or undefined when the locale plugin is absent.
 */
export function installLocaleService(service: LocaleServiceLike | undefined): void {
  localeService = service
  const waiting = [...pendingLocale]
  pendingLocale.clear()
  if (service === undefined) {
    // No service: the fallback snapshot is all there is, so the waiters are done
    // waiting. Notifying is the honest signal — they read `'zh'` before and after,
    // and leaving them parked would misreport a service that will never come.
    notifyAll(waiting)
    return
  }
  for (const notify of waiting) {
    try {
      localeLiveOff.set(notify, service.subscribe(notify))
    } catch (error: unknown) {
      console.warn('dsh-project-groups: failed to re-seat a locale listener', error)
    }
  }
  notifyAll(waiting)
}

/**
 * The active locale, for the settings card's injection preview.
 *
 * Not a {@link pendingSeat}: locale is not a project-model value, so the model's
 * baseline is not what it waits for — it waits for the locale service, which
 * `installLocaleService` supplies. It still parks early subscribers rather than
 * dropping them, and its disposer reaches the live subscription after the re-seat,
 * for the same reason every other seat here does.
 * `'zh'` before the service exists, matching the Host's own fallback when it cannot
 * read the setting.
 */
export const clientInjectionLocale: HostObservable<InjectionLocale> = {
  getSnapshot: () => injectionLocaleOf(localeService?.getSnapshot().active ?? 'zh'),
  subscribe: (listener) => {
    const service = localeService
    if (service !== undefined) return service.subscribe(listener)
    pendingLocale.add(listener)
    return () => {
      pendingLocale.delete(listener)
      const off = localeLiveOff.get(listener)
      if (off !== undefined) {
        localeLiveOff.delete(listener)
        off()
      }
    }
  },
}
