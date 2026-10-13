/**
 * Reading Session ids back out of a row key.
 *
 * A Session row's key is `session:<id>` — the Session and nothing else. An earlier
 * version appended `@<groupKey>` so that a Session changing group became a different
 * key, which `AnimatedRows` reads as "one row left, another arrived" and fades. That
 * could not tell a New Session apart from any other re-filing, so deleting a project
 * faded its Sessions instead of gliding them; a New Session now announces itself
 * separately (see `enteringKeys`) and the key is back to identity.
 *
 * This module still exists because a key is a string with a prefix, and probes compare
 * ids. Slicing the prefix inline in each probe is the failure this prevents: a probe
 * that left the prefix on would fail every id equality and report "no Session" rather
 * than failing loudly.
 *
 * Two forms are exported, because a probe runs this in two places:
 *
 *   - {@link parseRowKey} for Node-side code;
 *   - {@link PARSE_ROW_KEY_SOURCE} for injection into a `page.evaluate` body, where
 *     a Node import is not available.
 */

/** The literal prefix every Session row shares. */
export const SESSION_ROW_PREFIX = 'session:'

/**
 * Split one Session row key into its Session id.
 *
 * Self-contained — it references no module-level binding — so its own source can be
 * injected into a page (see {@link PARSE_ROW_KEY_SOURCE}). Inlining the literal is
 * what makes that possible; a closure over {@link SESSION_ROW_PREFIX} would throw
 * `ReferenceError` in the browser, where that binding does not exist.
 * @param rowKey - the `data-row-key` attribute value.
 * @returns the id, or `null` when this is not a Session row.
 */
export function parseRowKey(rowKey) {
  if (typeof rowKey !== 'string' || !rowKey.startsWith('session:')) return null
  return { id: rowKey.slice('session:'.length) }
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
 * {@link parseRowKey} as source text, for injection into a `page.evaluate` body.
 *
 * Probes parse row keys inside the browser, where this module cannot be imported.
 * Interpolating the function's own source keeps one implementation rather than a
 * copy per probe, which is the failure mode this whole module exists to prevent.
 */
export const PARSE_ROW_KEY_SOURCE = `(${String(parseRowKey)})`

/**
 * Install `window.__parseRowKey` / `window.__sessionIdOf` on every page this context
 * loads.
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
window.__sessionIdOf = key => { const parsed = window.__parseRowKey(key); return parsed === null ? null : parsed.id };`)
}

/**
 * A `page.evaluate`-safe expression that resolves a row key to its Session id.
 *
 * Declared as text so a probe can drop it directly into an in-page function body.
 */
export const SESSION_ID_OF_SOURCE = `(key => { const p = ${PARSE_ROW_KEY_SOURCE}(key); return p === null ? null : p.id })`
