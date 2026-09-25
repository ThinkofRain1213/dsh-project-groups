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

The vendored tree is **byte-identical to upstream** — verified by hash, file by
file, against `packages/client/ui-workspace/src/` at `dsh-v0.1.7-rc.2`. No file
has been edited.

All adaptation lives *outside* this directory, so a re-sync stays a plain copy:

| Where | Adaptation | Reason |
|---|---|---|
| `src/client/index.ts` | re-exports `apply` / `inject` from the vendored entry | gives project logic one seam to hook, and keeps the loader id this plugin's |
| `tsdown.config.ts` | specifier classification and the CSS Modules virtual loader | builds the tree as an independent plugin rather than as an official package |
| `cordis.patch.yml` | disables the official `ui-workspace` row | two claimants of the single slot, and two providers of `uiWorkspace`, would be a hard startup error |

Nothing inside `src/vendored/` should ever be edited. If a behaviour change is
needed, it belongs in `src/client/`, so this directory can be re-copied from a
new upstream tag without merge work.

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
