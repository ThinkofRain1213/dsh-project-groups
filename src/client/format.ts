/**
 * Small formatting and visibility helpers for the flat session list.
 *
 * These mirror the official sidebar browser's list rules (subagent rows are
 * never listed, a blank placeholder only shows while it is the current
 * session, archived rows follow the viewer's filter) so that replacing the
 * browser does not silently change which conversations appear.
 */

/** Coarse re-render cadence for relative time labels. */
export const SESSION_ROW_TIME_TICK_MS = 60_000

/** Which archived rows the list admits. Mirrors the official three-way filter. */
export type ArchivedFilter = 'default' | 'show' | 'only'

/** The subset of a list row the visibility rules read. */
export interface VisibleRowLike {
  readonly id: string
  readonly blank: boolean
  readonly origin?: 'subagent'
}

/**
 * Whether one Session belongs in the browsing list.
 *
 * Subagent sessions are never top-level rows. A blank (never-prompted)
 * session is a provisional placeholder and only appears while it is the
 * selected session. Archived membership then follows the filter.
 *
 * @param row - the candidate row.
 * @param current - the selected session id, when one is open.
 * @param archived - the registry-global archived id set.
 * @param filter - the viewer's archived filter.
 * @returns true when the row should be listed.
 */
export function sessionVisible(
  row: VisibleRowLike,
  current: string | undefined,
  archived: ReadonlySet<string>,
  filter: ArchivedFilter,
): boolean {
  if (row.origin === 'subagent') return false
  if (row.blank && row.id !== current) return false
  switch (filter) {
    case 'default': return !archived.has(row.id)
    case 'show': return true
    case 'only': return archived.has(row.id)
  }
}

/**
 * A compact relative-time label ("now", "5 min", "3 h", "2 d").
 *
 * The unit words come from the registration's locale seat, so the plugin ships
 * one dictionary pair and needs no per-locale branching here.
 *
 * @param timestamp - epoch milliseconds of the row's last activity.
 * @param now - epoch milliseconds of the current tick.
 * @param t - locale seat bound to the `project-groups` namespace.
 * @returns the compact label.
 */
export function relativeTime(
  timestamp: number,
  now: number,
  t: (key: 'time.now' | 'time.min' | 'time.hour' | 'time.day', params?: { n: number }) => string,
): string {
  const elapsed = Math.max(0, now - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < minute) return t('time.now')
  if (elapsed < hour) return t('time.min', { n: Math.floor(elapsed / minute) })
  if (elapsed < day) return t('time.hour', { n: Math.floor(elapsed / hour) })
  return t('time.day', { n: Math.floor(elapsed / day) })
}
