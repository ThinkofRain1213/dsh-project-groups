/** The fork action: one `sidebar.workspaces.session.menu.item` row. */
import { useState } from 'react'
import { IconBranchOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ForkSessionInjected, SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Menu row (order 300): fork at the Session's last completed turn; the child
 * arrives through the Host list beside its source.
 * @param props - owner share, menu open state, and the fork share.
 * @returns the row.
 */
export function ForkSessionMenuItem({
  sessionId, useMenuOpenState, useShortcuts, forkSession, t,
}: SessionMenuItemProps<ForkSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'session.fork'))
  // The row disables itself while a fork is in flight.
  //
  // Without this a second click started a second fork of the same Session: the menu closes on
  // the first, but the row is reachable again immediately and nothing said the request was
  // still outstanding. The failure notice is raised by the implementation, so this only has to
  // track the in-flight state and let the rejection fall through — caught, because the promise
  // rejects by design and an unhandled rejection here would be noise, not information.
  const [forking, setForking] = useState(false)
  return (
    <MenuItemButton
      shortcut={shortcut}
      disabled={forking}
      icon={<IconBranchOutlineRegular />}
      onSelect={() => {
        if (forking) return
        setMenuOpen(false)
        setForking(true)
        void forkSession(sessionId)
          .catch(() => { /* reported by the implementation */ })
          .finally(() => { setForking(false) })
      }}
    >
      {t('menu.fork')}
    </MenuItemButton>
  )
}
