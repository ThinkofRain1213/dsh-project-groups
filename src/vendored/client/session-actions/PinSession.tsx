/**
 * The pin action: a `sidebar.workspaces.session.menu.item` row and a
 * `sidebar.workspaces.session.row.action` button over one injected behavior.
 * Pin and archive are mutually exclusive on the Host, so the action reads both
 * sets and does not offer itself on an archived row; what a pin does beyond
 * the Host call (fronting the Session in its saved orders, the failure
 * notice) lives in the injected callbacks, not here.
 */
import {
  IconPinFillRegular, IconPinOutlineRegular, MenuItemButton, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { PinSessionInjected, SessionMenuItemProps, SessionRowActionProps } from '../contract/slots.ts'
import css from '../rows/Rows.module.css'

/** The share both pin entries read; the access Hook is the browser root's standard seat, on either. */
type PinState = Pick<
  SessionMenuItemProps<PinSessionInjected>,
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
 * Menu row (order 100): pin or unpin by the row's current state; absent on
 * archived rows and while the access snapshot excludes that toggle.
 * @param props - owner share, the pin share, the access Hook, and the menu open state.
 * @returns the row, or null for an archived or refused Session.
 */
export function PinSessionMenuItem(props: SessionMenuItemProps<PinSessionInjected>) {
  const { sessionId, useMenuOpenState, pinSession, unpinSession, t } = props
  const [, setMenuOpen] = useMenuOpenState()
  const { pinned, archived, allowed } = usePinState(props)
  if (archived || !allowed) return null
  return (
    <MenuItemButton
      icon={pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        ;(pinned ? unpinSession : pinSession)(sessionId)
      }}
    >
      {t(pinned ? 'menu.unpinSession' : 'menu.pinSession')}
    </MenuItemButton>
  )
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
