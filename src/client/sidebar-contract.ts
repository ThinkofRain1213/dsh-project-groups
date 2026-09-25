/**
 * Local type-only declaration of the sidebar shell's `sidebar.workspaces` slot.
 *
 * `@deepseek-ai/dsh-client-ui-workspace` declares `sidebar.workspaces` as a
 * `single` root slot — the whole browsing region — and
 * `@deepseek-ai/dsh-client-ui-sidebar` declares the hole it fills. Both have
 * been present since the sidebar's first published release, and the slot's
 * `single` kind plus its `priority` shadowing rule are documented behaviour of
 * `@deepseek-ai/dsh-client-ui-slots`.
 *
 * The contract is restated here instead of imported so the plugin keeps its
 * cross-version stance: those packages are versioned in lockstep with one DSH
 * release line, and depending on them would pin this plugin to that line for a
 * declaration a handful of fields wide.
 *
 * If you ever add them as devDependencies, delete this file and import their
 * contracts instead — the two augmentations describe the same slot and must not
 * drift.
 */
import type { GlobalStandardProps, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectGroupsKey } from './locales.ts'

/** One Session as the sidebar list projects it (the subset this plugin reads). */
export interface SessionListRow {
  readonly id: string
  /** Durable title, or a display fallback derived from cwd/id when unset. */
  readonly displayTitle: string
  readonly updatedAt: number
  readonly blank: boolean
  readonly running: boolean
  readonly cwd?: string
  /** Present only on subagent-origin sessions. */
  readonly parentId?: string
  readonly origin?: 'subagent'
}

/** The Session list snapshot's read side (the value of the `useSessions` hook). */
export interface SessionListSnapshot {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionListRow | undefined>>
  readonly phase: string
}

/** One workspace row: its registered directory, title, and accounted sessions. */
export interface WorkspaceRow {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

/**
 * The workspace controller's snapshot as the sidebar consumes it. Only the
 * fields this plugin reads are restated: the archived id set (the list's
 * default filter) and the workspace rows with their paths (used by a later
 * layer to locate the default workspace).
 */
export interface WorkspaceSnapshot {
  readonly items: readonly WorkspaceRow[]
  readonly archivedSessionIds: readonly string[]
  readonly pinnedSessionIds?: readonly string[]
  readonly phase: string
}

/**
 * The share this plugin's registration injects.
 *
 * Navigation is delegated to the sidebar owner's `uiWorkspace` service rather
 * than reimplemented, because that service already owns the blank-session
 * reuse rule, the recent-workspace fallback, and main-view replacement. This
 * plugin shadows the owner's *entry*; it does not replace its service.
 */
export interface ProjectGroupsInjected {
  /** Start (reuse or create) a blank Session in a Workspace, then open it. */
  readonly startSession: (workspaceId?: string) => void
  /** Open an existing Session in the main view. */
  readonly open: (sessionId: string) => void
}

/** Owner props the sidebar shell passes into the `sidebar.workspaces` entry. */
export interface SidebarWorkspacesOwnerProps {
  /** Sidebar width state: true renders the wide (labelled) form. */
  readonly wide: boolean
  /** Request the sidebar expand to its wide form. */
  readonly expandSidebar: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The sidebar's whole browsing region. `single`, so exactly one entry
     * renders per priority cell; the lowest priority wins and a losing entry
     * stays on the ledger, so unregistering the winner restores it.
     */
    'sidebar.workspaces': {
      kind: 'single'
      scope: 'root'
      owner: SidebarWorkspacesOwnerProps
    }
  }

  interface GlobalStandardProps {
    /** Selector hook over the framework's Session list snapshot. */
    readonly useSessions: <S>(selector: (state: SessionListSnapshot) => S) => S
    /** Selector hook over the workspace controller's snapshot. */
    readonly useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
  }

  interface LocaleNamespaceMap {
    /** The browsing region's copy. */
    'project-groups': ProjectGroupsKey
  }
}

/**
 * Full props the component receives, composed from the four seats explicitly
 * rather than through `PropsRuntime`:
 *
 * - `SidebarWorkspacesOwnerProps` — the parent renderSlot call site
 * - `ProjectGroupsInjected` — this registration's inject face
 * - `GlobalStandardProps` — the framework's `useSessions` / `useWorkspaces`
 * - `PropsLocale` — the `t` seat bound to this plugin's namespace
 *
 * `PropsRuntime` is unavailable here because its inject face resolves through
 * the registration site, which a type-only module augmentation cannot name.
 * Composing the four faces keeps the contract readable and pins exactly what
 * the component may read.
 */
export type ProjectGroupsProps =
  & SidebarWorkspacesOwnerProps
  & ProjectGroupsInjected
  & GlobalStandardProps
  & PropsLocale<'project-groups'>
