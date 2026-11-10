/**
 * The pin action's hover button over one injected behavior. The menu row of the
 * same name is contributed as structured data by
 * `session-actions/context-menus.tsx`; this file keeps only the
 * `sidebar.workspaces.session.row.action` button. Pin and archive are mutually
 * exclusive on the Host, so the action reads both sets and does not offer
 * itself on an archived row; what a pin does beyond the Host call (fronting the
 * Session in its saved orders, the failure notice) lives in the injected
 * callbacks, not here.
 */
import {
  IconPinFillRegular, IconPinOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { PinSessionInjected, SessionRowActionProps } from '../contract/slots.ts'
import css from '../rows/Rows.module.css'

/** The share the hover button reads; the access Hook is the browser root's standard seat. */
type PinState = Pick<
  SessionRowActionProps<PinSessionInjected>,
  'sessionId' | 'usePinned' | 'useArchived' | 'useSessionAccess'
>

/**
 * The row's pin and archive membership, one Set lookup each, and whether the
 * caller's access snapshot allows the toggle it would perform.
 */
function usePinState({ sessionId, usePinned, useArchived, useSessionAccess }: PinState) {
  const pinned = usePinned(pinned => pinned.has(sessionId))
  return {
    pinned,
    archived: useArchived(archived => archived.has(sessionId)),
    // The toggle, not the verb: an unpin asks a different endpoint than a pin.
    allowed: useSessionAccess(sessionId, pinned ? 'workspace/unpinSession' : 'workspace/pinSession'),
  }
}

/**
 * Hover button (order 200, rightmost: it lands where the rest-state pin marker
 * sits), also visible without hover when pinned; absent on archived rows and
 * while the access snapshot excludes that toggle. Tooltip forwards the class to
 * the button, so keep it directly inside the display-contents slot anchor:
 * `pinnedAction` is what the hoverless rules key on to keep Unpin (and hide
 * everything else) on a touch device.
 * @param props - owner share, the pin share, and the access Hook.
 * @returns the button, or null for an archived or refused Session.
 */
export function PinSessionRowButton(props: SessionRowActionProps<PinSessionInjected>) {
  const { sessionId, pinSession, unpinSession, t } = props
  const { pinned, archived, allowed } = usePinState(props)
  if (archived || !allowed) return null
  return (
    <Tooltip label={t(pinned ? 'actions.unpin' : 'actions.pin')} side="bottom" align="end" delayMs={500} portal>
      <button
        type="button"
        className={clsx(css.iconButton, pinned && css.pinnedAction)}
        aria-label={t(pinned ? 'menu.unpinSession' : 'menu.pinSession')}
        onClick={() => { (pinned ? unpinSession : pinSession)(sessionId) }}
      >
        {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}
