/** Derived observable sources for the row actions' injected hooks. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Project one observable into another, recomputing only when the source
 * snapshot changes identity, so consumers that select from the projection
 * (a Set lookup per row) never rebuild it per read.
 *
 * ## Why there is an explicit "computed" flag
 *
 * `undefined` is a legitimate projection result for a generic `derive<S, T>`, and `S`
 * itself may legitimately be `undefined` — `HostObservable<readonly GroupSource[] |
 * undefined>` is exactly that shape upstream. Using the value as the cache-miss sentinel
 * therefore defeated the memoization whenever `project` returned `undefined`: the
 * condition stayed true, so `project` re-ran on every `getSnapshot()` and re-built the
 * projection per read for precisely the expensive projections this helper exists to
 * avoid. The flag records "a value has been computed" rather than inferring it from the
 * value, and `seen` is only read once that is true.
 * @param source - the observable to project.
 * @param project - pure projection of one source snapshot.
 * @returns the projected observable, subscribing through the source.
 */
export function derive<S, T>(source: HostObservable<S>, project: (snapshot: S) => T): HostObservable<T> {
  let computed = false
  let seen: S | undefined
  let value: T | undefined
  return {
    getSnapshot: () => {
      const snapshot = source.getSnapshot()
      if (!computed || snapshot !== seen) {
        // `seen` is committed only **after** `project` returns.
        //
        // Advancing it first meant a projection that threw left the memo claiming to have
        // handled that snapshot: on a later read of the same snapshot the `snapshot !== seen`
        // test was false, so the stale `value` was returned without re-running and without
        // surfacing the error again. A projection bug became a silently wrong value. With the
        // order reversed a throw leaves `seen` untouched, so the next read retries and throws
        // again where a caller can see it.
        const next = project(snapshot)
        seen = snapshot
        value = next
        computed = true
      }
      return value as T
    },
    subscribe: listener => source.subscribe(listener),
  }
}
