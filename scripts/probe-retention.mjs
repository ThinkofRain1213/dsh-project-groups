/**
 * Why the caller must hand retention every key it owns.
 *
 * `retainAccountKeys` prunes `groupExpansion` / `sessionOrderByAccount` down to
 * exactly the keys it is given. That is correct store behaviour — it is how a
 * deleted Workspace's remembered state stops accumulating — and it means the
 * caller is responsible for naming every key that should live on.
 *
 * The shipped call site names the Workspace ids and the two browser-local
 * accounts. A caller-supplied project's id was not among them, so a project's
 * remembered expansion was pruned on every run. This drives the real store to
 * show the mechanism, and to show that the corrected key list keeps it.
 *
 * The end-to-end consequence — the expansion surviving a real reload — is
 * measured in a browser by `scripts/probe-prune-race.mjs`; this file is the
 * unit-level statement of the same rule.
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

// 1. The mechanism: retention keeps only what it is handed.
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
  check('a key the caller does not name is pruned',
    after['project-abc'] === undefined, JSON.stringify(after))
  check('and a key it does name survives', after[UNGROUPED_KEY] === true)
}

// 2. The rule the call site must follow: name every key it owns, so the
//    project's expansion is retained alongside the Workspace ids.
{
  const store = createWorkspaceViewStore().create()
  store.actions.setGroupExpanded('project-abc', true)
  store.actions.setGroupExpanded('project-xyz', true)
  store.actions.setGroupExpanded(UNGROUPED_KEY, true)

  store.actions.retainAccountKeys([...BROWSER_ACCOUNTS, 'workspace-1', 'project-abc', 'project-xyz'])
  const after = store.getSnapshot().groupExpansion
  check('naming the project keys retains them',
    after['project-abc'] === true && after['project-xyz'] === true, JSON.stringify(after))
}

// 3. Retention still prunes: a project that no longer exists must not linger,
//    or the corrected list would trade a lost record for an unbounded one.
{
  const store = createWorkspaceViewStore().create()
  store.actions.setGroupExpanded('project-deleted', true)
  store.actions.setGroupExpanded('project-live', true)

  // The list a call site would build once `project-deleted` is gone.
  store.actions.retainAccountKeys([...BROWSER_ACCOUNTS, 'project-live'])
  const after = store.getSnapshot().groupExpansion
  check('a key for a project that no longer exists is still pruned',
    after['project-deleted'] === undefined, JSON.stringify(after))
  check('while the live project keeps its record', after['project-live'] === true)
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
