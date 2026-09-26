# Vendored official source — provenance and patch record

This directory is a **verbatim copy** of the official DSH sidebar workspace
browser, vendored so this plugin can own the sidebar region while keeping the
official UI 1:1.

## Provenance

| | |
|---|---|
| Upstream | `deepseek-ai/deepseek-harness` |
| Path | `packages/client/ui-workspace/src/` |
| Version | **0.1.7-rc.2** |
| Commit | `477b4f420` (`dsh-v0.1.7-rc.2`) |
| Copied | 2026-09-26 |

Copied files (23):

```
client/index.ts
client/navigation.ts
client/shortcuts.ts
client/stores.ts
client/tree.ts
client/pin-order.ts
client/locales.ts
client/WorkspacePicker.tsx
client/WorkspacePicker.module.css
client/contract/slots.ts
client/rows/WorkspaceBrowser.tsx
client/rows/WorkspaceBrowser.module.css
client/rows/Rows.tsx
client/rows/Rows.module.css
client/rows/AnimatedRows.tsx
client/rows/AnimatedRows.module.css
client/session-actions/ArchiveSession.tsx
client/session-actions/ForkSession.tsx
client/session-actions/PinSession.tsx
client/session-actions/RenameSession.tsx
client/session-actions/RowActionToast.tsx
client/session-actions/derived.ts
css-modules.d.ts
```

## Why vendored

The official package does not export its component, and every data seam that
could have let us swap behaviour underneath it is closed by an explicit
invariant — see `scripts/probe-approach-b.mjs` for the reproduction:

1. `ctx.slots.provideRoot` rejects a duplicate root standard hook
   (`useWorkspaces`), so the browser's data source cannot be replaced.
2. `ctx.provide` / `ctx.set` refuse a second provider for the `workspaces`
   service, so the controller cannot be replaced.
3. A replacement entry cannot re-declare the browser's child slots
   (`…session.menu.item` etc.), and `renderSlot` is authorised per entry, so it
   cannot render the official actions either.

Keeping the UI 1:1 therefore means owning a copy of it.

## De-branding

The vendored tree started as a **byte-identical copy** of upstream — verified by
hash, file by file, against `packages/client/ui-workspace/src/` at
`dsh-v0.1.7-rc.2`. It is no longer byte-identical: project grouping needed a
grouping seam, and the patches below are it. Every one is **structural and
optional**: with no override supplied, the code behaves exactly as upstream.

Most adaptation still lives *outside* this directory:

| Where | Adaptation | Reason |
|---|---|---|
| `src/client/index.ts` | wrapper that re-exports `apply` / `inject` and passes the grouping observable | gives project logic one seam to hook, and keeps the loader id this plugin's |
| `tsdown.config.ts` | specifier classification and the CSS Modules virtual loader | builds the tree as an independent plugin rather than as an official package |
| `cordis.patch.yml` | disables the official `ui-workspace` row | two claimants of the single slot, and two providers of `uiWorkspace`, would be a hard startup error |

### Patches inside this directory

Kept minimal and listed here so a re-sync is mechanical. Each is marked in the
source with a comment naming the seam.

| File | Patch | Re-sync action |
|---|---|---|
| `tree.ts` | adds `GroupSource`, `owningSourceKey`, and `groupBySource` (a line-for-line twin of `groupByWorkspace`); `deriveGroups` takes an optional 6th `sources` parameter | re-apply on top of the new `groupByWorkspace` |
| `contract/slots.ts` | adds a mandatory `grouping` hook to `WorkspaceBrowserInjected.hooks`, plus the `GroupSource` type import | re-add the one field + import |
| `rows/WorkspaceBrowser.tsx` | consumes `useGrouping`, threads `groupingOverride` into `SessionTree`, uses it for `ungroupedMemberIds` / `expandedGroups` / the two `owningGroupKey` call sites | re-apply the same six edits |
| `rows/WorkspaceBrowser.tsx` | `onCreate` drops its `if (group.workspaceId !== undefined)` guard and always expands (**behaviour change**, see below) | remove the guard again |
| `rows/Rows.tsx` | labels the Ungrouped bucket by **empty label** rather than missing `workspaceId` | one-line change; a caller-supplied group has no Workspace id but does have a label |
| `navigation.ts` | `startSession` without a target resolves the Host's default Workspace instead of guessing (**behaviour change**, see below) | restore the shipped guess, or re-apply |
| `index.ts` | `apply` takes an optional `groupingOverride` and forwards it into the `grouping` hook | re-add the parameter and the hook field |

Two invariants keep these patches honest:

1. **Absent override = upstream behaviour.** `deriveGroups(..., undefined)`
   takes the untouched `groupByWorkspace` path, and the browser's `grouping`
   observable defaults to `undefined` (override inactive). Automated:
   `scripts/verify-grouping.mjs` and `scripts/probe-grouping-seam.mjs`.
2. **Grouping is a derivation, never data.** Nothing here writes Workspace
   membership, `cwd`, or archive state; the Host is untouched by construction.

### Deliberate behaviour deviations

These two are **not** structural seams: they change what the shipped code does.
They are listed apart so a re-sync does not silently drop them, and so an
upstream behavioural change is not mistaken for a merge conflict.

**1. New Session without a target goes to the default Workspace.**

Shipped: an unscoped `startSession()` guessed — the current Session's Workspace,
then the most recently used one — and cleared the selection when neither
existed. Now it resolves the Host's default Workspace through
`initializeDefault` (a pure read once the registry records one), and with no
default it does nothing: no guess, no cleared selection.

Rationale: every Session this plugin creates lives in that one Workspace, so the
destination should not depend on whatever the user last did.

**2. The Ungrouped bucket's ＋ button works.**

Shipped: `Rows.tsx` rendered the button unconditionally while
`WorkspaceBrowser.tsx` guarded its handler with `group.workspaceId !== undefined`,
so on the Ungrouped bucket (and on any group without a Workspace id) the button
rendered and did nothing. The same component guards its row menu, hover card and
drag wiring on that same field, so the missing guard reads as an oversight rather
than a decision — and one upstream test pins the inert behaviour
(`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`,
"…its ＋ is inert"), which is why it has survived.

Consequence for re-sync: that upstream test asserts the opposite of what this
copy does. Expect it to fail against our tree; it is not a regression.

Nothing else inside `src/vendored/` should be edited. A behaviour change that is
not one of the seams above belongs in `src/client/`.

## Keeping it in sync

Upstream ships this package at the same version as the whole harness line, so a
DSH upgrade is the signal to re-copy. The plugin's `devDependencies` pin the
version the copy came from.

Re-sync procedure:

1. fetch the matching tag in the harness checkout and check it out;
2. re-copy `packages/client/ui-workspace/src/client/` and `src/css-modules.d.ts`
   over `src/vendored/`;
3. update the provenance table above;
4. `pnpm check` — `scripts/compare-bundle.mjs` fails loudly if the vendored tree
   no longer resolves the same externals as the installed official bundle.

Because the tree is unedited, a failed re-sync surfaces as a build or
verification error rather than as a silent behavioural drift.
