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
| `rows/WorkspaceBrowser.tsx` | `onCreate` files what a row creates: a project row under itself through `assignSession`, the Ungrouped bucket under **nothing** through `unassignSession` (see below) | re-apply the three-way `file` dispatch |
| `rows/WorkspaceBrowser.tsx` | expansion is routed by key ownership: caller-supplied keys go through `setProjectExpanded` / `projectExpansion`, every other key through the view store (see below) | re-apply `isCallerOwned` / `recordExpansion` / `hasExpansion` and the merge in `expandedGroups` |
| `rows/WorkspaceBrowser.tsx` | caller-supplied groups get the same two-mode member ordering the Workspace rows get, from `orderedProjects` + the `orders` hook; `commitSessionDrag` resolves a caller key after the Workspace lookup; `saveSessionOrder` and the order menu dispatch by key ownership (see below) | re-apply `orderedProjects` / `allProjectOrders`, the `?? groupingOverride?.find(...)` in `commitSessionDrag`, and the two dispatches |
| `rows/WorkspaceBrowser.tsx` | a Session can be dragged **between** groups: `DragState.overGroupKey` names the target, a row drop is positional and a header drop is not, and `commitCrossGroupDrag` files it through `assignSession` / `unassignSession` before writing the order (see below) | re-apply `overGroupKey`, `canReceiveDrag`, `insertIntoTargetOrder`, `commitCrossGroupDrag`, and the `groupDrop` wiring |
| `rows/Rows.tsx` | a Session row's `dragover` / `drop` call `stopPropagation`, so the row is the target rather than the enclosing group section; `ProjectRowItem` takes an optional `groupDrop` that makes the **header row** — not the section — the cross-group hit target (the highlight stays on the section, painted by the region) | re-add the two calls and the `groupDrop` prop and handlers |
| `tree.ts` | under a grouping override the Ungrouped bucket always renders, empty included — it is the drop target that takes a Session back out of a caller-supplied group (see below) | re-apply the `archivedFilter !== 'only'` alternative |
| `navigation.ts` | `startSession` takes an optional `beforeOpen` callback and threads it into `openWorkspace`, so a caller can act on the Session that lands (a project row files it). Omitted, the flow is unchanged | re-add the parameter and the pass-through |
| `rows/WorkspaceBrowser.tsx` | rename/delete dialogs and the group drag take a `kind`-tagged row (`RowRequest`), so a caller-supplied project row drives the same affordances as a Workspace row; the header's add control runs `createProject` when the composition supplies one, and the dialog titles/labels switch on that kind | re-apply the dispatch, the two dialog blocks, and the drag wiring |
| `rows/Rows.tsx` | labels the Ungrouped bucket by **empty label** rather than missing `workspaceId` | one-line change; a caller-supplied group has no Workspace id but does have a label |
| `rows/Rows.tsx` | the row menu's delete label and the menu's aria-label follow `group.kind` | small change; a project's delete removes a record, not a registry entry |
| `locales.ts` | project copy (`project.add`, `project.create.*`, `rename.project.title`, `delete.project*`, `field.projectName`, `create`, `actions.project.aria`) in both dictionaries | add the keys |
| `navigation.ts` | `startSession` without a target resolves the Host's default Workspace instead of guessing (**behaviour change**, see below) | restore the shipped guess, or re-apply |
| `navigation.ts` | the service takes an optional `placeUnscoped` callback, applied only when `beforeOpen` is absent, so the caller can file an unscoped New Session (**behaviour change**, see below) | re-add the parameter and the `beforeOpen ??` composition |
| `index.ts` | `apply` takes an optional `groupingOverride`, an optional `ProjectActions`, and optional `expansionsOverride` / `ordersOverride`, forwarding all into the inject face | re-add the parameters and the hook/verb fields |
| `rows/Rows.tsx` | adds `sessionRowKey(id, groupKey)`: a Session row's animation identity carries its owning group (`session:<id>@<groupKey>`) instead of the bare id (**behaviour change**, see below) | re-add the helper and its doc block |
| `rows/Rows.tsx` | `SessionNodeItem` takes an optional `rowKey`, and its `data-row-key` is `rowKey ?? sessionRowKey(node.id)` | re-add the prop and the fallback |
| `rows/WorkspaceBrowser.tsx` | the grouped view passes `sessionRowKey(node.id, group.key)` twice — into `rowKeys` and into the row's `rowKey` — in the same order | re-apply both call sites together |
| `contract/slots.ts` | adds `BaseWorkspaceMissingRequest` / `BaseWorkspaceDialogInjected` / `BaseWorkspaceDialogProps`: the report a New Session raises when its 底层工作区 is gone | re-add the three declarations |
| `navigation.ts` | the service takes an optional `onBaseWorkspaceMissing` callback, raised where `startSessionInDefaultWorkspace` previously returned silently (**behaviour change**, see below). Omitted, the flow is unchanged | re-add the parameter and the one call |
| `session-actions/BaseWorkspaceMissing.tsx` | **new file**: the `shell.overlay` dialog that reports that case and offers the two repairs | re-add the file and its `shell.overlay` registration |
| `locales.ts` | six `baseMissing.*` keys in both dictionaries, kept in one contiguous block rather than editing a shipped key | re-add the block |
| `rows/WorkspaceBrowser.module.css` | `.baseMissingActions` (the column footer), `.baseMissingBody`, `.baseMissingPath` | re-add the three rules |
| `contract/slots.ts` | adds `BaseWorkspaceRoute`: which of three outcomes the caller's 底层工作区 setting resolved to | re-add the union |
| `navigation.ts` | the service takes an optional `resolveBaseWorkspace` callback, consulted by an unscoped `startSession` **before** the official default (**behaviour change**, see below). Omitted, the flow is unchanged | re-add the parameter and the two branches |
| `index.ts` | `ProjectActions` gains an optional `resolveBaseWorkspace`, passed as the constructor's last argument | re-add the field and the pass-through |
| `session-actions/BaseWorkspaceMissing.tsx` | the 重新指定底层工作区 button now consumes the report and calls `chooseBaseWorkspace`, handing the user to the settings card | re-add the `settle()` before the call |
| `session-actions/BaseWorkspaceMissing.tsx` | the 重建该工作区 button's action is live (step 3b), and the dialog states that a directory will be created before it offers it | re-add the hint paragraph |
| `locales.ts` | one `baseMissing.rebuildHint` key in both dictionaries, appended to the existing `baseMissing.*` block | re-add the key |
| `rows/WorkspaceBrowser.module.css` | `.baseMissingHint` | re-add the rule |
| `contract/slots.ts` | `BaseWorkspaceDialogInjected.chooseBaseWorkspace` is documented as wired (step 3a); the type is unchanged | no code change beyond the doc |

Two invariants keep these patches honest:

1. **Absent override = upstream behaviour.** `deriveGroups(..., undefined)`
   takes the untouched `groupByWorkspace` path, and the browser's `grouping`
   observable defaults to `undefined` (override inactive). Automated:
   `scripts/verify-grouping.mjs` and `scripts/probe-grouping-seam.mjs`.
2. **Grouping is a derivation, never data.** Nothing here writes Workspace
   membership, `cwd`, or archive state; the Host is untouched by construction.

### Deliberate behaviour deviations

These are **not** structural seams: they change what the shipped code does.
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

Which **project** that Session joins is then a second question, and it belongs to
the caller: `startSession` takes an optional `placeUnscoped` callback, and when it
is present an unscoped call routes the landed Session through it. The callback is
given the new Session and the one the user was looking at; the caller owns the
project model and decides. Absent, the Session is left where the default Workspace
resolution put it.

This is the one place every unscoped entry converges, which is why the seam is
here rather than in the browser: the shell's New Session button and its shortcut,
and any plugin that starts a Session without a target, all reach it. A row's own
＋ never does — it states its destination through `beforeOpen`, and `beforeOpen`
wins.

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

Making the button work was not enough on its own. Its handler sent **no**
`beforeOpen` callback, which made the click indistinguishable from an unscoped one
— the shell's New Session button, whose destination the caller's policy decides.
The click then resolved the default Workspace, reused the blank Session already
sitting there, and inherited whatever project that Session had been filed under.
Since every project shares one Workspace (a project has no directory), using any
project's ＋ once was enough to make the Ungrouped ＋ create under that project
from then on.

So `onCreate` now states the destination for both rows: a project row files under
itself through `assignSession`, the Ungrouped bucket files under nothing through
`unassignSession`, and a real Workspace row — which predates projects — files
nothing at all. The third branch is unreachable in this composition (the override
is always an array, so the region always groups by source) but is kept explicit so
that composing this browser *without* an override cannot silently unassign a real
Workspace's Session.

**3. A caller-owned group's expansion is stored by the caller, not here.**

Shipped: every group's expansion lives in this browser's view store, which is
persisted to `dsh.workspace.view.v5`. The official plugin persists to the **same
key**, and its mount calls `retainAccountKeys` with the Workspace ids and the two
browser-local accounts — pruning every key it is not handed. That pruning is
correct for the official plugin's own data; it is fatal for a caller-supplied
group, whose key is not a Workspace id. A project's remembered expansion was
therefore deleted the first time the official sidebar mounted, which is exactly
what switching this plugin off does. Reloading alone did not lose it, which is
why the symptom looked intermittent.

The region now routes expansion by key ownership: a key the caller supplies goes
to the caller through `setProjectExpanded` and is read back from the `expansions`
hook, while every other key keeps using the view store exactly as upstream. The
two records cannot collide, because a caller-owned key is never written here.

This is why `expansions` is a **mandatory** hook with a default rather than an
optional one: the renderer binds hooks from the observable's identity, so a
composition without this state supplies an observable answering an empty record,
and with no verb alongside it every key resolves to the view store — upstream
behaviour, unchanged.

An earlier attempt kept the key in the view store and taught retention about it.
That was reverted: it left the caller's state in the official plugin's key space,
which is the coupling this design exists to remove. The measured account of that
attempt is in `DESIGN.md` under L2c.

**4. Caller-supplied groups order their members like Workspace rows do.**

Shipped: member position inside a group comes from `orderedWorkspaces` /
`orderedUngroupedSessionIds` / `orderedFlatSessionIds`, keyed by Workspace id, and
`commitSessionDrag` looks a dragged row's group up among Workspace ids — so a
caller-supplied group's key resolved to nothing and its drags committed no order.
The rows could be dragged and showed an insertion marker; releasing did nothing.

`orderedProjects` mirrors the same two-mode computation for caller-supplied
groups, reading their order from the `orders` hook instead of the view store, and
`commitSessionDrag` now resolves a caller key after the Workspace lookup. The
three shipped orderings are untouched, and `activeSessionOrders` deliberately
still excludes caller groups, so the two effects that reconcile blank-session
pinning and manual orders never see them.

The dispatch is by key ownership, as with expansion:

  - a caller-owned key writes through `setProjectOrders`;
  - every other key — a Workspace, and the Ungrouped bucket — keeps using
    `setSessionOrder` and the view store, exactly as upstream.

Because recency ordering needs no record (a member without one falls back to
`updatedAt`), the mode's lifecycle is expressed in the caller's store too: picking
manual writes every group's current order (freezing them), and picking recency
writes an empty map (discarding them). Without the freeze the menu would read
"manual" while an untouched group kept re-sorting itself.

Nothing else inside `src/vendored/` should be edited. A behaviour change that is
not one of the seams above belongs in `src/client/`.

**5. A Session can be dragged between caller-supplied groups.**

Shipped: a Session drag never leaves its group. `compatibleTarget` requires the
drag's account key to equal the group's, so a row in another group does not even
`preventDefault` the event, and the group section's `onDragOver` is `undefined`
unless a **Workspace-row** drag is in flight.

Two drop paths, and they mean different things:

  - **on a row** — a positional drop. The Session is filed, inserted at that
    position, and the view switches to manual ordering, which is upstream's rule
    for any sort gesture.
  - **on the header row** — a drop *into* the group. Under recency nothing is
    stored: the member has no saved position, so `reconcileManualOrder` derives one
    from `updatedAt`. Under manual it goes to the front, the one position a header
    drop can name.

The target is the header **row**, not the enclosing group section: the section is
taller than its children — it owns the 2px `margin-top` between each pair — and
covers the space beside them, so accepting a drop there would let a Session land in
a group from a pointer nowhere near a drop position. That is the flash seen while
dragging past a project.

The **highlight**, though, is painted on the whole group (the section). Hit testing
and highlight answer different questions here: the row is what can be dropped on,
the group is what the drop means. Painting the highlight on the row says the wrong
thing, and painting the *target* on the section is the bug above — so the two are
deliberately split. `GroupDropProps` therefore carries no `active` flag: the region
already holds the state and paints the section from it.

`DragState.overGroupKey` carries the target, and `over === null` distinguishes a
header drop from a positional one — which is why `commitSessionDrag`'s second
parameter is now nullable. Filing goes through `assignSession` /
`unassignSession`, and the order through the same key-ownership dispatch the
same-group path uses. With either verb absent, `canReceiveDrag` is false and the
region behaves exactly as upstream.

Three supporting changes:

  - a Session row's `dragover` / `drop` `stopPropagation`, so the row wins over
    the enclosing group section (which would otherwise replace the positional
    marker with a group-level target);
  - the header's `groupDrop` asserts the target on `dragover`, not only on
    `dragenter`. Both enter and leave also fire when the pointer crosses a *child*
    of the row (the folder glyph, the chevron, the title) and they bubble, so
    moving within the header would fire a `dragleave` that cancelled a highlight
    the pointer never left. Asserting on the continuously-firing `dragover` makes
    the state self-correcting; the setter is idempotent so those events do not
    re-render;
  - the Ungrouped bucket always renders under an override, because it is the drop
    target that takes a Session back out of a project. `groupByWorkspace` keeps
    the shipped strays-only rule, and the archived-only view still hides an empty
    bucket.

**6. A Session row's animation key carries its group.**

Shipped: a Session row's `data-row-key` is `session:<id>`, and `AnimatedRows` reads
that attribute to decide, per commit, whether a row is new (entry fade) or merely
moved (glide). Upstream gets away with a key that says nothing about the group,
because a Session's group there is its Workspace — assigned at creation and never
re-filed — so a row never changes group at all.

Here it does. Every project shares the one default Workspace (a project has no
directory), and the blank New Session is a single Session that the front end
re-files between projects. Under the shipped key, A's ＋ then B's ＋ is the same key
in a new position, which `AnimatedRows` renders as a **glide**: the row travels
across the sidebar from one project to the other. Measured frame by frame, that
transition has twelve intermediate positions and a
`transform+opacity→transform+opacity` animation. Upstream's own cross-Workspace
transition, by contrast, fades: `opacity→opacity`, no transform.

So the grouped view now passes `sessionRowKey(node.id, group.key)`, which yields
`session:<id>@<groupKey>`. The same Session under a new group becomes a *different*
key — the old one leaves and the new one arrives, both fading — and the Session id
itself is untouched, so nothing outside `AnimatedRows` can tell the difference.

`blank` is deliberately **not** folded into the key: a blank New Session becoming
real stays in its group, so its key does not change and the row is patched in place
with **no** animation. That is what upstream does, measured as one surviving DOM
node with zero movement and zero fade, and folding `blank` in would replace it with
a cross-fade on every first prompt.

The flat "In one list" view is left on the shipped key: its rows have no group to
change, so it keeps upstream's string byte for byte.

Both call sites must agree — `rowKeys` (the ordered array `AnimatedRows` diffs) and
the row's own `data-row-key` — because the two are paired by position. They call the
same helper for that reason. `scripts/probe-row-key-motion.mjs` asserts the four
transitions, and fails two of its cross-project checks against the shipped key.

**7. A New Session with no resolvable Workspace says so.**

Shipped: `startSessionInDefaultWorkspace` returns as soon as the default Workspace
cannot be resolved, so clicking New Session did **nothing at all** — no Session, no
notice, no navigation. The failure notice in `RowToast` does not cover this case: it
belongs to the *throwing* path (`initializeDefaultWorkspace`'s `catch`), while a
deleted registration makes `initializeDefault` return `undefined` rather than throw.
The host-lookup test pins that notice, so it stays.

Now the service raises an optional `onBaseWorkspaceMissing` callback at that point,
and the region answers it with a dialog: the missing path, then the two repairs —
re-create the Workspace, or choose another one. Step ① of the rollout wires neither
repair, so the dialog renders both buttons **disabled** and 取消 is the only live
action. That is deliberate: a button that appears to work and does nothing is the
very bug this change removes.

The path comes from the Host (`projectGroups/defaultWorkspacePath`), because it starts
at the OS Documents folder and no browser can read that. It is filled in *after* the
dialog opens — the report is raised synchronously by the failing click, and a
`powershell.exe` spawn must not delay the dialog — so the dialog shows "path unknown"
for one beat when the Host answers. `src/default-workspace.ts` explains why the
official derivation is reimplemented rather than imported (its subpath is not in the
package's `exports`).

Layout: the actions are a **column**, not the shared `Modal` footer's right-aligned
row. Three equal row actions get about 77px each in the default card, which is less
than 「重新指定底层工作区」 needs; a column gives each the card's full width. The
official plugin-manager dialog does the same (`.installFooter { flex-direction: column }`).

**8. An unscoped New Session lands where the caller says.**

Shipped: `startSession()` without a target resolves the Host's default Workspace, and
that was patch 2 above. This patch adds a step **before** it: if the caller supplies a
`resolveBaseWorkspace`, its answer decides.

The callback returns a three-member union, and the third member is the point. "Use the
official default" and "the setting names a Workspace that is gone" both end up not
opening a specific Workspace, so an `workspaceId | undefined` return could not tell them
apart — collapsing them would either silence the report or make the healthy path shout.
`'missing'` therefore raises `onBaseWorkspaceMissing` with `mode: 'specified'` (the report
typed `'specified'` from the start; this is the patch that finally produces it) and
creates **nothing**. Falling back to the official default would be indistinguishable from
the setting being ignored, which is the defect the whole feature exists to fix.

Which entries reach this: every one that states no destination — the shell's New Session
button and its shortcut, `ui-schedule`, `ui-agent-preset`, **and a caller-supplied group's
own ＋**. That last one is easy to miss and is measured: `tree.ts` builds those groups
with `workspaceId: undefined`, so a project row's ＋ takes this same branch (confirmed by
watching `workspace/initializeDefault` fire on that click). The routing therefore also
applies to a project's ＋ and the Ungrouped bucket's ＋.

`beforeOpen` rides through on the `'workspace'` arm, which is what lets a Session land in
the chosen Workspace **and** still be filed: a project's ＋ files it under that project,
while the shell's button applies the caller's placement policy. Returning early there
would create the Session and drop the filing.

Omitted, the flow is byte-for-byte the shipped one — that is the "plugin off, official
behaviour" guarantee. `startSessionInDefaultWorkspace` is untouched, so the
`defaultWorkspaceFailed` notice and the host-lookup test that pins it are unaffected.

**9. The missing-workspace report hands off to the chooser.**

The dialog's 重新指定底层工作区 button used to render disabled: it needed a chooser, and the
chooser lives on this plugin's settings card, in another package. This patch wires it —
`settle()` first, then `chooseBaseWorkspace` — so the report does not follow the user to
the other page and stack over the dialog they are being sent to.

The navigation itself is the caller's (see `src/client/index.ts`): the plugin manager
publishes `pluginNavigation.openBundle(name)`, which does `selectPanel('plugins')` and
`setView({ kind: 'package', name })` in one call, measured to mount our card from a
third-party cordis fiber. Two details of that service are worth recording, because both
change how it must be reached:

- it is published from **inside the manager's page slot** and disposed with it
  (`ctx.reflect.provide` followed by a `yield` disposer, a couple of hundred characters
  inside a `slots.register` body), so declaring it in `inject` would gate the whole plugin
  on a service that comes and goes. The ungated `ctx.get` is the read;
- the official voice-input plugin's `inject: ['pluginNavigation']` is a **sub-fiber**
  (`ctx.inject([...], registerUi)`), so it is not a pattern that transfers to a plugin
  which must keep working without the manager.

Opening the chooser is a second handoff, dialog → card, and it rides a snapshot store
rather than a prop because the card generally mounts **after** the request: `openBundle`
navigates, the card is created by that render. A snapshot read returns live state, so a
card mounted later still sees the request, and consuming it (setting `null`) is what stops
the chooser from reopening whenever the card remounts.

**10. 重建该工作区 becomes live, and says what it will do.**

The dialog's other repair lands in step 3b: the button's action now exists, so it is no longer
disabled, and the dialog states that a directory will be created at that path **before** offering
it — this is the only action in the feature that writes to the disk.

Nothing else here changed: the button already received `rebuildBaseWorkspace` through the injected
face, and the Host side lives in `src/index.ts` (`mkdir` then `workspaceRegistry.create`, with the
path taken from the plugin's own setting rather than from the caller). See `DESIGN.md` for why the
`'default'` mode is adopted into `'specified'` rather than repaired in place.

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

## Verifying the deviations

Three of them are behavioural and cannot be seen from a unit test, so they have
browser probes that drive a live instance. They are run by hand rather than by
`pnpm check`, because each needs a booted server:

| Probe | What it drives | Why it is not in `check` |
|---|---|---|
| `scripts/probe-browser-console.mjs` | loads the UI and fails on any page error | needs a booted instance |
| `scripts/probe-browser-flow.mjs` | creates a project, files a Session, reloads, deletes | needs a booted instance |
| `scripts/probe-plugin-toggle.mjs` | boots **both** profiles itself and switches between them | spawns servers on a fixed port |
| `scripts/probe-project-reorder.mjs` | drags one Session over another inside a project | spawns a server |
| `scripts/probe-order-mode.mjs` | switches the order menu and reads the Host's stored records | spawns a server; **needs an empty `dshHome`** (it asserts the arriving state) |
| `scripts/probe-cross-group.mjs` | drags Sessions between projects and out to Ungrouped | spawns a server |
| `scripts/probe-drop-highlight.mjs` | checks the cross-group highlight is on the group section while the pointer is on the header row, and that the section itself accepts no drop | spawns a server |
| `scripts/probe-ungrouped-plus.mjs` | drives the Ungrouped ＋ after a project's ＋, and reads the Host's assignment table to see where the Session landed | spawns a server |
| `scripts/probe-new-session-target.mjs` | writes the destination setting over the plugin's own RPC, then drives the shell's New Session button under each value | spawns a server |
| `scripts/probe-settings-card.mjs` | drives this plugin's own Plugin manager page: the card renders at all, its menu is themed in both colour schemes, and a choice drives the New Session button | spawns a server |
| `scripts/probe-recent-blank.mjs` | rewrites two projects' `createdAt` with the Host stopped, so the one holding a reused blank Session must lose to the newer one | spawns a server, restarts it |
| `scripts/probe-new-session-motion.mjs` | records the sidebar frame by frame while a project row's ＋ is pressed, on a blank Session that has been collapsed and re-created, so a placement that renders the previous owner for one frame shows up as a glide instead of a fade | spawns a server; the pre-fix bundle must fail its two cross-project checks |
| `scripts/probe-row-key-motion.mjs` | samples every Session row each animation frame across all four transitions (a project's ＋, the same ＋ again, another project's ＋, a blank becoming real) plus a cross-group drag, so a glide shows as a run of intermediate positions and a fade as `opacity→opacity`; asserts the blank→real case has no animation at all | spawns a server; the shipped `session:<id>` key must fail its four cross-project checks |
| `scripts/probe-base-workspace-dialog.mjs` | deletes the default Workspace's **registration** (files and Sessions kept, by design) and then clicks New Session: asserts the dialog appears instead of silence, names the Host-derived path, stacks three full-width non-overflowing actions, leaves the two repairs disabled, and that 取消 closes it without writing | spawns a server; the shipped silent `return` must fail its "dialog appears" check |

`probe-plugin-toggle.mjs` owns its lifecycle deliberately: localStorage is scoped
to an origin, and an origin includes the port, so running the two profiles on
different ports would give them separate storage and the probe would pass whether
or not the bug existed. It boots each profile in turn on one fixed port with a
single browser context open across all three phases.

Usage (it needs the executable, the asar root, and an isolated home):

```
node scripts/probe-plugin-toggle.mjs \
  "C:\...\DeepSeek Harness.exe" \
  "C:\...\resources\app.asar" \
  "C:\...\.agent\temp\toggle-home"
```

The home must already have the two profiles prepared — `pg` with this plugin
added, and `official` without it. `probe-plugin-toggle.mjs` switches between them
and asserts that a project's expansion survives the round trip.
