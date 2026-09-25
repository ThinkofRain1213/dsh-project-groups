# dsh-project-groups

**[中文](README.zh.md) | English**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.7--rc.2-5965d8)](https://github.com/deepseek-ai/deepseek-harness)

A [DSH](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness) plugin that replaces the sidebar's **Workspace** browser with a flat conversation list, collecting every session into one **Ungrouped** bucket.

It is the first layer (L0) of a project-grouping plugin built for **full-permission workflows**, where workspaces tied to directories get in the way.

---

## Why

DSH's Workspace is a **directory ownership** record, not a grouping label:

- A session belongs to a workspace because its immutable `cwd` equals the workspace's `path` — membership is *derived on every read*, never stored as a relation.
- There is no RPC to move a session between workspaces, and `cwd` is frozen by design (`deepFreeze`, no writer anywhere in the harness).
- Creating a workspace forces a directory picker, and its initial title is the folder's basename.

So a workspace can never answer "which of my projects is this conversation part of". This plugin takes the sidebar over for that answer, while leaving every byte of the official data untouched.

## What it does (L0)

- **Takes over the browsing region.** Registers into the sidebar's `sidebar.workspaces` slot at a lower priority than the official workspace browser. The slot is `single`, so the lowest priority renders and the official entry simply stays unrendered on the ledger.
- **Collects everything into one bucket.** Every visible conversation is listed flat under a single *Ungrouped* header. Sessions that officially live in different workspaces appear side by side.
- **Keeps the official list rules.** Subagent sessions, blank placeholders, and archived sessions follow the same visibility rules the official browser uses, so replacing it does not change which conversations you see.
- **Fully reversible.** Nothing is written. Disable or uninstall the plugin and the official workspace browser returns exactly as it was — including any workspace you renamed.

## What it does *not* do (yet)

L0 is the first of six planned layers. Deliberately absent for now:

- project records and drag-to-assign (**L1–L2**)
- session actions the takeover displaces — archive, pin, rename, fork, search (**L3**)
- default-workspace creation for new sessions (**L4**)
- per-project work documents and their injection into new sessions (**L5**)

Until **L3**, use the plugin with the understanding that those row actions are not available while it owns the sidebar. Turning it off restores them immediately.

## Install

Requires DSH **≥ 0.1.7-rc.2**.

```bash
dsh plugin add dsh-project-groups
```

Or install from a local checkout:

```bash
git clone https://github.com/ThinkofRain1213/dsh-project-groups.git
cd dsh-project-groups
pnpm install && pnpm build
dsh plugin add .
```

Restart DSH afterwards. The plugin ships a `cordis.patch.yml` that inserts its row into the web profile's client roster.

### Verifying

1. The sidebar's Workspaces section is replaced by **Ungrouped**, listing your conversations flat.
2. Clicking a row opens that conversation; **New session** still creates one.
3. Disable the plugin → the official Workspaces section returns unchanged.

## How it works

The plugin registers into a slot the DSH shell declares:

```ts
ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
  { name: 'sidebar.workspaces', priority: -100, locale: NS, inject: () => ({ startSession, open }) },
  ProjectGroups,
))
```

`sidebar.workspaces` is a `single` slot: exactly one entry renders per priority cell, the **lowest** priority wins, and a losing entry stays registered. Priority `-100` therefore displaces the official browser (registered at the default `0`) without destroying it — disposing this registration restores the official one with no further work.

Conversation data comes from the framework's global standard hooks (`useSessions`, `useWorkspaces`), which official plugins provide at root. Nothing is persisted, so L0 carries no host-side behaviour.

### Reversibility is the design constraint

Everything is display-layer:

| | |
|---|---|
| Session `cwd` / header | never written |
| Official `archivedSessionIds` | read only |
| Session logs and directories | never touched |
| Official workspace registry | never written |

## Compatibility

- **DSH:** ≥ 0.1.7-rc.2
- **Platform:** web (`dsh.client.platform: web`)
- **Host:** no host-side behaviour at L0

The plugin restates the slot contract locally instead of importing the official packages, so it is not pinned to one DSH release line. It declares the official packages only as optional dev-time peer dependencies for type-checking.

## Development

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/index.js + lib/client.js
pnpm watch       # rebuild on change
```

`lib/` is committed so the plugin can be installed straight from a git clone.

Source layout:

| Path | Role |
|---|---|
| `src/index.ts` | Host half (no behaviour at L0) |
| `src/client/index.ts` | Browser apply: the slot registration |
| `src/client/ProjectGroups.tsx` | The flat list component |
| `src/client/format.ts` | Visibility rules and relative-time labels |
| `src/client/locales.ts` | zh/en dictionaries |
| `src/client/sidebar-contract.ts` | Local type-only slot contract |
| `DESIGN.md` | Full architecture, verified harness facts, L0–L5 plan |

## Design notes

`DESIGN.md` records the harness facts this plugin depends on, each verified against the shipped `app.asar`:

- workspace membership is derived from `cwd` and `cwd` is immutable (no writer anywhere);
- deleting a workspace permanently drops its session accounting — re-importing the same directory yields an empty workspace;
- only `workspaceId` on `session/create` accounts a session; passing `cwd` leaves it Ungrouped;
- the official `initializeDefault` refuses to run outside a completely empty install;
- shadowing a `single` slot also suppresses its declared child slots, which is why the displaced row actions return in **L3**.

## License

[MIT](LICENSE)
