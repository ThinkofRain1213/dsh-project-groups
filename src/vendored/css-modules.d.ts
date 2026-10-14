/**
 * Ambient declarations for CSS imports in this vendored tree.
 *
 * ## Why `*.css` is bodyless
 *
 * `declare module '*.css'` with no body types every plain CSS import — including a
 * side-effect import such as `import './global.css'` — as `any`. That is deliberate and is
 * the only form available: an ambient wildcard module cannot be given an inline annotation
 * in a way TypeScript accepts, so the choice is between this and failing to compile at all.
 *
 * The `any` is scoped tightly in practice. Nothing in this tree imports a plain `.css`
 * today — the only imports are `*.module.css`, which is declared above with a real shape
 * (`Record<string, string>` keyed by the local class name) — so this branch exists for the
 * upstream file that may add a side-effect import on the next re-sync, and the built output
 * carries the stylesheet either way. If one is ever added, type the import and this becomes
 * narrower rather than wider.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
