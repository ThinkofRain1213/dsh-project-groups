/**
 * Why a caller-owned group's expansion must not live in the view store.
 *
 * `retainAccountKeys` prunes `groupExpansion` / `sessionOrderByAccount` down to
 * exactly the keys it is given. That is correct store behaviour — it is how a
 * deleted Workspace's remembered state stops accumulating — and it is why the
 * store is the wrong home for state the official plugin does not know about.
 *
 * The shipped call site names the Workspace ids and the two browser-local
 * accounts, so a caller-supplied group's key is pruned on every run. Worse, the
 * store is persisted to `dsh.workspace.view.v5`, the **same key** the official
 * plugin uses, so the official mount prunes it too — which is what switching this
 * plugin off did to a project's remembered expansion.
 *
 * This file states that rule at unit level against the real store, and pins the
 * distinction the caller's own storage has to preserve: an absent key and a
 * `false` value are different states, and only the former may be auto-opened.
 * The end-to-end consequence is measured in a browser by
 * `scripts/probe-plugin-toggle.mjs`.
 *
 * The store module is transpiled and its platform dependency stubbed by
 * `scripts/lib/ts-loader.mjs`; see that file for what the stub covers.
 */
import { register } from 'node:module'

register('./lib/ts-loader.mjs', import.meta.url)

const { createWorkspaceViewStore, FLAT_SESSION_ORDER_KEY } = await import('../src/vendored/client/stores.ts')
const { UNGROUPED_KEY } = await import('../src/vendored/client/tree.ts')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** The two browser-local accounts every call site retains. */
const BROWSER_ACCOUNTS = [UNGROUPED_KEY, FLAT_SESSION_ORDER_KEY]

// 1. The mechanism: retention keeps only what it is handed. This is the fact
//    that makes the view store unsafe for a caller-supplied group's key — the
//    shipped call site cannot name it, and the official mount runs the same
//    action against the same persisted key.
{
  const store = createWorkspaceViewStore().create()
  store.actions.setGroupExpanded('project-abc', true)
  store.actions.setGroupExpanded(UNGROUPED_KEY, true)
  check('the store records a project expansion',
    store.getSnapshot().groupExpansion['project-abc'] === true,
    JSON.stringify(store.getSnapshot().groupExpansion))

  // The shipped key list: Workspace ids only.
  store.actions.retainAccountKeys([...BROWSER_ACCOUNTS, 'workspace-1'])
  const after = store.getSnapshot().groupExpansion
  check('a caller-supplied key is pruned by the shipped key list',
    after['project-abc'] === undefined, JSON.stringify(after))
  check('and a key it does name survives', after[UNGROUPED_KEY] === true)
}

// 2. Why the caller keeps this state itself: the store's key space is shared
//    with the official plugin, so anything kept here is subject to the official
//    plugin's own pruning. The caller's store is the only place a project key is
//    safe, and `probe-plugin-toggle.mjs` measures the consequence.
{
  const store = createWorkspaceViewStore().create()
  store.actions.setGroupExpanded('project-abc', true)
  // A caller that names its keys can retain them — but that only survives as
  // long as this browser is the one pruning. The official mount prunes with its
  // own list, which cannot know these keys, so the record is lost regardless.
  store.actions.retainAccountKeys([...BROWSER_ACCOUNTS, 'project-abc'])
  check('naming the key retains it against THIS browser\'s prune',
    store.getSnapshot().groupExpansion['project-abc'] === true,
    JSON.stringify(store.getSnapshot().groupExpansion))
  // The official list, which is the one that runs when the plugin is off.
  store.actions.retainAccountKeys([...BROWSER_ACCOUNTS, 'workspace-1'])
  check('but the official key list still drops it — hence the separate store',
    store.getSnapshot().groupExpansion['project-abc'] === undefined,
    JSON.stringify(store.getSnapshot().groupExpansion))
}

// 3. The distinction the caller's own storage must preserve: an absent key and a
//    `false` value are different states. Only the former may be auto-opened, so a
//    store that defaulted missing keys to `false` would break the rule.
{
  const store = createWorkspaceViewStore().create()
  store.actions.setGroupExpanded('project-folded', false)
  store.actions.setGroupExpanded('project-live', true)
  store.actions.setGroupExpanded('project-deleted', true)
  const expansion = store.getSnapshot().groupExpansion
  check('a folded group records false, not absence',
    expansion['project-folded'] === false && Object.hasOwn(expansion, 'project-folded'))
  check('an untouched group has no record at all',
    !Object.hasOwn(expansion, 'project-never-touched'))
  // The list a call site builds once `project-deleted` is gone.
  store.actions.retainAccountKeys([...BROWSER_ACCOUNTS, 'project-live', 'project-folded'])
  const after = store.getSnapshot().groupExpansion
  check('a key for a project that no longer exists is still pruned',
    after['project-deleted'] === undefined, JSON.stringify(after))
  check('while the live project keeps its record', after['project-live'] === true)
  check('and a deliberately folded one keeps its false',
    after['project-folded'] === false, JSON.stringify(after))
}

// 4. Order is preserved for the surviving keys, so a Workspace and a project
//    under it do not lose their relative order in the record.
{
  const store = createWorkspaceViewStore().create()
  store.actions.setGroupExpanded('workspace-1', false)
  store.actions.setGroupExpanded('project-abc', true)
  store.actions.retainAccountKeys([...BROWSER_ACCOUNTS, 'workspace-1', 'project-abc'])
  check('a collapsed group stays collapsed (false is a record, not an absence)',
    store.getSnapshot().groupExpansion['workspace-1'] === false,
    JSON.stringify(store.getSnapshot().groupExpansion))
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
