/**
 * The grouping model this plugin feeds the vendored sidebar browser.
 *
 * ## What a project is
 *
 * A title plus (from L2) the Sessions filed under it. It is **not** a
 * Workspace: it owns no directory, contributes nothing to the Host registry,
 * and never touches a Session's `cwd`. Every Session stays in the Host's
 * default Workspace; the project is the grouping the sidebar draws on top.
 *
 * ## Where it lives
 *
 * L1-1 stages the model in the browser ({@link ProjectModel}) so the sidebar can
 * be exercised before the persistence seam exists. `ctx.storageDomain` and the
 * Remote namespace that reach it are L1-2; that step replaces the storage
 * behind this model, not the model's API. While staged, projects do not survive
 * a reload.
 *
 * ## Why an override rather than the Workspace registry
 *
 * The observable is never `undefined`: `undefined` means "group by the Host
 * Workspace registry" (upstream), while an array — empty included — is an active
 * override. A fresh install's empty array is the honest state: the feature
 * exists and no project has been created, so every Session is Ungrouped.
 *
 * ## Why the Host is unaffected
 *
 * Grouping is a derivation in the browser (`tree.ts` `deriveGroups`). Nothing
 * here writes Workspace membership, `cwd`, or archive state, so switching this
 * back to `undefined` — or disabling the plugin — restores the official
 * workspace-grouped sidebar with all its data intact.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { GroupSource } from '../vendored/client/tree.ts'
import { ProjectModel } from './projects.ts'

/** The project model this plugin's sidebar is a view of. */
export const projects = new ProjectModel()

/** The observable handed to the vendored browser. */
export const clientGrouping: HostObservable<readonly GroupSource[] | undefined> = projects.grouping
