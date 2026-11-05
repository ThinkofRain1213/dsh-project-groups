/**
 * The project row's own context-menu family: `target: 'project'`.
 *
 * ## Why a new target family exists at all
 *
 * Upstream rc.1 triggers a header row's menu from
 *
 * ```ts
 * const workspaceMenuTarget = row.workspaceId !== undefined && row.cwd !== undefined
 *   ? { workspaceId: row.workspaceId, path: row.cwd } : undefined
 * ```
 *
 * A **project** in this plugin is a label, not a directory: it has no `workspaceId` and no
 * `cwd`, so that expression is always `undefined` for one. Reusing `target: 'workspace'` is
 * not an option either — upstream's resolve reads the single `target.value.path`, and a
 * project may have **0, 1 or N** associated directories (`src/spec.ts`: `directories:
 * z.array(z.string()).default([])`, "any number, including none"). A reused Workspace
 * target would silently show only the first directory of a multi-directory project.
 *
 * `ui-context-menu`'s `ContextMenuTargetMap` is documented as extensible — "External
 * plugins extend this map with their own target families" — and `MenuAction` carries
 * `children?: readonly MenuAction[]`, so the N-directory case expands into a submenu
 * instead of losing directories.
 *
 * ## The three menu rows, and the three-state reveal
 *
 * Order is fixed: `rename` (100) / `reveal` (200) / `remove` (300), with `remove` alone
 * marked `danger` and `separatorBefore`. The reveal row is the part worth reading closely:
 *
 * - **0 directories** — no row at all. A project may be a pure label, and a "show in
 *   folder" entry with no folder is an action that can only fail.
 * - **1 directory** — one row that runs directly, with **no** `children`. The context-menu
 *   layer refuses to select a row that carries `children` (`selected.action.children !==
 *   undefined` guards the dispatch), so a single-element submenu would be a dead row.
 * - **N directories** — one parent row whose `children` are the directories in stored
 *   order, labelled with the raw path. The parent carries **no** `run`: the layer never
 *   calls one on a parent, and a `run` there would be a lie in the type.
 *
 * ## Why the pure function is separate from the registration
 *
 * `projectMenuActions` takes the captured target, the caller's verbs and a translator, and
 * returns plain data. `scripts/verify-project-menu.mjs` imports it and asserts the three
 * states against the real code — a submenu built with `slice(1)` instead of a full `map`,
 * or a parent that also carries `run`, both survive a code review and break the menu. For
 * that test to load this module under Node's type stripping, the module must import
 * **types only** and contain no JSX, which is also why the icon is referenced by key
 * (`project.reveal`, registered in the browser half) rather than by component.
 *
 * ## What this file does not own
 *
 * The verbs: `rename` opens the project's edit dialog, `remove` the delete confirmation,
 * and `reveal` hands a directory to the Host's file manager. All three live in
 * `src/client/index.ts`, because two of them are the browser's existing dialogs and the
 * third is a Remote call — see `ProjectMenuActions`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContextMenuTargetMap, MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
// Type-only: pulls the `ctx.contextMenus` merge and the `workspace` locale namespace.
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface ContextMenuTargetMap {
    /**
     * One project row of this plugin's sidebar.
     *
     * `directories` is captured with the target rather than re-read at resolve time, so an
     * open menu can never disagree with the row the user right-clicked. Empty is
     * meaningful and common: a project may be a label with no directory at all.
     */
    project: {
      readonly projectId: string
      readonly title: string
      readonly directories: readonly string[]
    }
  }
}

/**
 * The verbs one project menu row runs.
 *
 * Supplied by the caller rather than implemented here: two of the three are surfaces the
 * browser already owns — the edit dialog and the delete confirmation — and the third is a
 * Host Remote call, which this module has no context to make.
 */
export interface ProjectMenuActions {
  /** Open the project's edit dialog (title, directories, links, spec). */
  rename(id: string): void
  /** Open the delete confirmation for a project; its Sessions return to Ungrouped. */
  remove(id: string): void
  /**
   * Show one directory in the Host's file manager.
   * @param path - absolute host path, as stored on the project.
   * @returns resolves once the Host accepted the launch; rejects to surface a failure in
   * the shared menu's own notice.
   */
  reveal(path: string): Promise<void>
}

/** The locale keys this family reads; all three live in the `workspace` namespace. */
type ProjectMenuKey = 'edit.project' | 'delete.project' | 'menu.reveal'

/** A translator bound to the `workspace` namespace. */
type ProjectMenuTranslate = (key: ProjectMenuKey) => string

/** Icon key registered by the browser half's `contextMenu.icon` seat. */
const REVEAL_ICON = 'project.reveal'

/**
 * The reveal row, in whichever of its three shapes the project's directory list calls for.
 *
 * Extracted rather than inlined because the three arms are the whole point of this
 * feature and reading them side by side is how the "1 directory has no `children`" rule
 * stays visible.
 * @param directories - the project's directories, in display order.
 * @param actions - the caller's verbs.
 * @param t - bound translator.
 * @returns zero or one action.
 */
function revealActions(
  directories: readonly string[],
  actions: ProjectMenuActions,
  t: ProjectMenuTranslate,
): readonly MenuAction[] {
  // A project may be a label with no directory: there is nothing to show, so there is no
  // row. Returning a disabled row instead would suggest the project is misconfigured.
  if (directories.length === 0) return []
  const icon = { key: REVEAL_ICON }
  if (directories.length === 1) {
    // No `children`, even of length one: the shared popup skips a row that carries
    // children, so a single-element submenu would be a row that does nothing on click.
    const path = directories[0] as string
    return [{ id: 'reveal', label: t('menu.reveal'), icon, run: () => actions.reveal(path) }]
  }
  return [{
    id: 'reveal',
    label: t('menu.reveal'),
    icon,
    // A parent row: `children` is what opens the submenu, and a `run` here would never be
    // called — the menu layer only dispatches leaf rows.
    children: directories.map((path, index) => ({
      id: `reveal:${index}`,
      // The raw path, not a basename: two projects often hold sibling directories whose
      // basenames collide, and the full path is what tells them apart.
      label: path,
      run: () => actions.reveal(path),
    })),
  }]
}

/**
 * The complete action list for one captured project target, in menu order.
 *
 * @param target - the project the menu was opened on.
 * @param actions - the caller's verbs.
 * @param t - translator bound to the `workspace` namespace.
 * @returns up to three actions: rename, reveal (0 or 1), remove.
 */
export function projectMenuActions(
  target: ContextMenuTargetMap['project'],
  actions: ProjectMenuActions,
  t: ProjectMenuTranslate,
): readonly MenuAction[] {
  return [
    {
      id: 'rename',
      label: t('edit.project'),
      // Reuses the Workspace family's keys: the same pencil and the same trash can, so a
      // project row and a Workspace row do not disagree about what an action looks like.
      icon: { key: 'workspace.rename' },
      run: () => { actions.rename(target.projectId) },
    },
    ...revealActions(target.directories, actions, t),
    {
      id: 'remove',
      label: t('delete.project'),
      icon: { key: 'workspace.delete' },
      danger: true,
      // Alone in asking for a hairline: a separator above `reveal` would split it from
      // rename, and one above `rename` would draw before the menu's first row.
      separatorBefore: true,
      run: () => { actions.remove(target.projectId) },
    },
  ]
}

/**
 * Which contribution provides which action, in ascending menu order.
 *
 * One contribution per action rather than one returning all three: `order` is a property
 * of the contribution, so a single registration could not interleave with another
 * plugin's project actions the way the session family does.
 */
const CONTRIBUTIONS = [
  { id: 'rename', order: 100 },
  { id: 'reveal', order: 200 },
  { id: 'remove', order: 300 },
] as const

/**
 * Register the three project menu contributions.
 *
 * Withdrawn when this plugin unloads, like every other `ctx.contextMenus` registration.
 * @param ctx - client root context (its inject list names `contextMenus` and `locale`).
 * @param actions - the caller's verbs.
 */
export function registerProjectMenu(ctx: Context, actions: ProjectMenuActions): void {
  const t = ctx.locale.bind('workspace')
  for (const { id, order } of CONTRIBUTIONS) {
    ctx.effect(() => ctx.contextMenus.register({
      id: `project.${id}`,
      target: 'project',
      order,
      // Each contribution resolves the whole list and keeps its own row. Recomputing is
      // cheap (pure data), and it keeps the ordering and the tri-state reveal in one place
      // instead of three copies that could drift.
      resolve: target => projectMenuActions(target, actions, t).filter(action => action.id === id),
    }), `project-groups: ${id} menu action`)
  }
}
