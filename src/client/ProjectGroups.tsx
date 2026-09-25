/**
 * The flat "Ungrouped" conversation list that replaces the sidebar's workspace
 * browser at L0.
 *
 * Every visible Session lands in one bucket. The list groups by nothing: the
 * plugin owns the sidebar region, and rendering one flat bucket is what
 * displaces the official workspace sections while this entry is the slot's
 * winner.
 *
 * Data comes entirely from the framework's global standard hooks
 * (`useSessions`, `useWorkspaces`, both provided at root by official plugins)
 * plus the injected `t` seat. No plugin-owned state exists at L0.
 */
import * as React from 'react'
import type { ProjectGroupsProps, SessionListRow, SessionListSnapshot, WorkspaceSnapshot } from './sidebar-contract.ts'
import { relativeTime, SESSION_ROW_TIME_TICK_MS, sessionVisible } from './format.ts'

/**
 * Render the flat list: a bucket header, the visible Session rows in the
 * framework's activity order, and a New Session affordance.
 * @param props - owner share, injected navigation, standard hooks, and locale seat.
 * @returns the browsing region's element tree.
 */
export function ProjectGroups(props: ProjectGroupsProps) {
  const useSessions = props.useSessions as <S>(selector: (state: SessionListSnapshot) => S) => S
  const useWorkspaces = props.useWorkspaces as <S>(selector: (state: WorkspaceSnapshot) => S) => S
  const list = useSessions(state => state)
  const archivedIds = useWorkspaces(state => state.archivedSessionIds)
  const now = useNow()
  const archived = React.useMemo(() => new Set(archivedIds), [archivedIds])

  // Mirrors the official browser's list rules so replacing it does not change
  // which conversations appear (see `sessionVisible`).
  const rows = list.ids.flatMap((id) => {
    const row = list.byId[id]
    if (row === undefined) return []
    return sessionVisible(row, undefined, archived, 'default') ? [row] : []
  })

  const t = props.t

  return (
    <div className="dpg-root">
      <div className="dpg-header">
        <span className="dpg-header-title">{props.wide ? t('section.ungrouped') : ''}</span>
        <span className="dpg-header-count">{rows.length}</span>
      </div>
      <button
        type="button"
        className="dpg-new-session"
        aria-label={t('action.newSession.aria')}
        onClick={() => { props.startSession() }}
      >
        <span aria-hidden="true">＋</span>
        {props.wide && <span>{t('action.newSession')}</span>}
      </button>
      <div className="dpg-scroll" role="list">
        {rows.map(row => (
          <SessionRow
            key={row.id}
            row={row}
            now={now}
            openLabel={t('row.open.aria', { name: row.displayTitle })}
            timeText={relativeTime(row.updatedAt, now, t)}
            onOpen={() => { props.open(row.id) }}
          />
        ))}
        {rows.length === 0 && <p className="dpg-empty">{t('empty.sessions')}</p>}
      </div>
    </div>
  )
}

/** One Session row: title, relative time, and a running indicator. */
function SessionRow(
  { row, now, openLabel, timeText, onOpen }: {
    row: SessionListRow
    now: number
    openLabel: string
    timeText: string
    onOpen: () => void
  },
) {
  return (
    <div
      className="dpg-row"
      role="listitem"
      aria-label={openLabel}
      data-running={row.running ? 'true' : undefined}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
    >
      <span className="dpg-running" aria-hidden="true" />
      <span className="dpg-row-title">{row.displayTitle}</span>
      <span className="dpg-row-time" data-now={now}>{timeText}</span>
    </div>
  )
}

/**
 * A coarse clock so relative labels ("5 min") re-render without a per-second
 * tick. The interval is owned by this component and cleared on unmount, so
 * unloading the plugin leaves no timer behind.
 * @returns epoch milliseconds, refreshed on a coarse tick.
 */
function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, SESSION_ROW_TIME_TICK_MS)
    return () => { window.clearInterval(timer) }
  }, [])
  return now
}
