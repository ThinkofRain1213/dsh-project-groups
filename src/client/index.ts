/**
 * Browser apply for dsh-project-groups (L0).
 *
 * Registers this plugin's flat conversation list into the sidebar shell's
 * `sidebar.workspaces` hole at a lower priority than the official workspace
 * browser. The slot is `single`, so at most one entry renders per priority
 * cell and the lowest priority wins — the official browser is therefore
 * displaced rather than destroyed: it stays on the ledger, and disposing this
 * registration restores it with no further work.
 *
 * `PRIORITY` sits well below the official entry's default of 0. A strictly
 * lower value wins; an equal value would throw at registration time rather
 * than silently tie, which is why the gap is wide rather than a single step.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the SlotRegistry service (ctx.slots) into Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: merges the locale registry service (ctx.locale) into Context.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: merges this plugin's slot contract and standard hooks.
import type {} from './sidebar-contract.ts'
import { ProjectGroups } from './ProjectGroups.tsx'
import type { ProjectGroupsInjected } from './sidebar-contract.ts'
import { en, NS, zh } from './locales.ts'
import './styles.css'

export { PACKAGE_NAME } from './package-name.ts'

/** Registration priority for the browsing-region entry. */
const PRIORITY = -100

/** Required services: the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Register the flat browsing list once the sidebar shell declares its hole,
 * and publish this namespace's dictionaries.
 *
 * `slots.inject` waits for the declaration and withdraws the contribution if
 * it collapses, so load order relative to the sidebar plugin does not matter.
 * @param ctx - client root context.
 */
export function apply(ctx: import('@deepseek-ai/cordis').Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'project-groups: dictionaries')

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      priority: PRIORITY,
      locale: NS,
      inject: (): ProjectGroupsInjected => ({
        // Navigation is delegated to the sidebar owner's own service: it
        // already owns blank-session reuse, the recent-workspace fallback, and
        // main-view replacement, so this plugin shadows the entry, not the
        // behaviour behind it.
        startSession: (workspaceId) => {
          const owner = ctx.get('uiWorkspace') as
            | { startSession: (workspaceId?: string) => void }
            | undefined
          owner?.startSession(workspaceId)
        },
        open: (sessionId) => {
          const owner = ctx.get('uiWorkspace') as
            | { openSession: (sessionId: string) => void }
            | undefined
          owner?.openSession(sessionId)
        },
      }),
    },
    ProjectGroups as never,
  ))
}
