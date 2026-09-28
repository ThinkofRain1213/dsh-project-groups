/**
 * Reading Session ids back out of a row key.
 *
 * A grouped Session row's animation identity is `session:<id>@<groupKey>` — the
 * group is part of the key so that a Session changing group is a *different* key,
 * which is what makes the change an exit-and-enter fade rather than a glide across
 * the sidebar. See `sessionRowKey` in `src/vendored/client/rows/Rows.tsx`.
 *
 * That `@` suffix is why `rowKey.replace('session:', '')` is no longer the id. It
 * yields `session-<uuid>@<group>`, which then fails every equality check against a
 * real id — and a probe that compares ids would silently report "no Session" rather
 * than failing loudly. So every probe parses through here instead.
 *
 * Two forms are exported, because a probe runs this in two places:
 *
 *   - {@link parseRowKey} for Node-side code;
 *   - {@link PARSE_ROW_KEY_SOURCE} for injection into a `page.evaluate` body, where
 *     a Node import is not available.
 *
 * The group key is `''` for the Ungrouped bucket rather than absent, so a Session
 * moving into Ungrouped still changes its key. It is `undefined` — not `''` — for a
 * row that carries no group at all, which is how the flat "In one list" view renders
 * its rows, and that view is deliberately unchanged from upstream.
 */

/** The literal prefix every Session row shares. */
export const SESSION_ROW_PREFIX = 'session:'

/** The separator between a Session id and its group key. */
export const ROW_KEY_GROUP_SEPARATOR = '@'

/**
 * Split one Session row key into its Session id and optional group key.
 *
 * Self-contained — it references no module-level binding — so its own source can be
 * injected into a page (see {@link PARSE_ROW_KEY_SOURCE}). Inlining the literals is
 * what makes that possible; a closure over {@link SESSION_ROW_PREFIX} would throw
 * `ReferenceError` in the browser, where those bindings do not exist.
 *
 * A row key without the separator is a flat-list row: its group is `undefined`,
 * which is distinct from Ungrouped's `''`.
 * @param rowKey - the `data-row-key` attribute value.
 * @returns the parts, or `null` when this is not a Session row.
 */
export function parseRowKey(rowKey) {
  if (typeof rowKey !== 'string' || !rowKey.startsWith('session:')) return null
  const rest = rowKey.slice('session:'.length)
  const at = rest.indexOf('@')
  if (at === -1) return { id: rest, group: undefined }
  return { id: rest.slice(0, at), group: rest.slice(at + 1) }
}

/**
 * The Session id inside a row key, or `null` when this is not a Session row.
 * @param rowKey - the `data-row-key` attribute value.
 * @returns the Session id.
 */
export function sessionIdOf(rowKey) {
  return parseRowKey(rowKey)?.id ?? null
}

/**
 * The group key inside a Session row key.
 *
 * `''` is Ungrouped, `undefined` is a flat-list row (no group), and `null` means the
 * row is not a Session row at all.
 * @param rowKey - the `data-row-key` attribute value.
 * @returns the group key, or `null` when this is not a Session row.
 */
export function groupIdOf(rowKey) {
  const parsed = parseRowKey(rowKey)
  return parsed === null ? null : parsed.group ?? null
}

/**
 * {@link parseRowKey} as source text, for injection into a `page.evaluate` body.
 *
 * Probes parse row keys inside the browser, where this module cannot be imported.
 * Interpolating the function's own source keeps one implementation rather than a
 * copy per probe, which is the failure mode this whole module exists to prevent.
 */
export const PARSE_ROW_KEY_SOURCE = `(${String(parseRowKey)})`

/**
 * Install `window.__parseRowKey` / `window.__sessionIdOf` / `window.__groupIdOf` on
 * every page this context loads.
 *
 * Injected with `addInitScript` rather than called after each navigation, because a
 * probe may reload the page and a helper installed by a one-off `evaluate` would be
 * gone for the frames after that — leaving exactly the assertions that run on a
 * refreshed page with no parser.
 * @param page - the Playwright page to install into.
 * @returns a promise that resolves once the script is registered.
 */
export function installRowKeyHelpers(page) {
  return page.addInitScript(`${PARSE_ROW_KEY_SOURCE.replace('function parseRowKey', 'window.__parseRowKey = function parseRowKey')}
window.__sessionIdOf = key => { const parsed = window.__parseRowKey(key); return parsed === null ? null : parsed.id };
window.__groupIdOf = key => { const parsed = window.__parseRowKey(key); return parsed === null ? null : (parsed.group ?? null) };`)
}

/**
 * A `page.evaluate`-safe expression that resolves a row key to its Session id.
 *
 * Declared as text so a probe can drop it directly into an in-page function body.
 */
export const SESSION_ID_OF_SOURCE = `(key => { const p = ${PARSE_ROW_KEY_SOURCE}(key); return p === null ? null : p.id })`
