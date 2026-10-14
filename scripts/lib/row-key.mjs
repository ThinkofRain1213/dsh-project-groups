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
 *   - {@link parseRowKey} / {@link sessionIdOf} for Node-side code;
 *   - {@link PARSE_ROW_KEY_SOURCE} / {@link SESSION_ID_OF_SOURCE} for injection into a
 *     `page.evaluate` body, where a Node import is not available.
 */

/**
 * Split one Session row key into its Session id.
 *
 * Self-contained — it references no module-level binding — so its own source can be
 * injected into a page (see {@link PARSE_ROW_KEY_SOURCE}). That is why the `'session:'`
 * literal is written twice here rather than shared through a constant: a closure over a
 * module-level binding would throw `ReferenceError` in the browser, where that binding does
 * not exist, and the injection is the whole reason this function is shaped this way.
 *
 * (There *was* an exported `SESSION_ROW_PREFIX` constant alongside it. Nothing imported it —
 * it was dead in the repository — and it could not be used here anyway, so it was removed
 * rather than left as a second, unreachable answer to "what is the prefix".)
 * @param rowKey - the `data-row-key` attribute value.
 * @returns `{ id }` for a Session row, or `null` when this is not one.
 */
export function parseRowKey(rowKey) {
  if (typeof rowKey !== 'string' || !rowKey.startsWith('session:')) return null
  return { id: rowKey.slice('session:'.length) }
}

/**
 * The Session id inside a row key, or `null` when this is not a Session row.
 *
 * Kept as its own function — rather than each caller reaching for `parseRowKey(...)?.id` —
 * so the injected page-side helper can be this function's own source text
 * (see {@link SESSION_ID_OF_SOURCE}) instead of a hand-written copy of the same expression.
 * The two had already diverged once (`?.id ?? null` here against `parsed === null ? null :
 * parsed.id` in the page), which is the class of drift this module exists to prevent.
 * @param rowKey - the `data-row-key` attribute value.
 * @returns the Session id, or `null`.
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
 * {@link sessionIdOf} as source text, for the same reason as
 * {@link PARSE_ROW_KEY_SOURCE}.
 *
 * It calls `parseRowKey` as a bare identifier, so {@link installRowKeyHelpers} publishes that
 * function under its own name on the page global first — a global property is resolvable as a
 * bare identifier in the page's scope, which is what lets this be the real function's source
 * instead of a rewritten copy of it.
 */
export const SESSION_ID_OF_SOURCE = `(${String(sessionIdOf)})`

/**
 * Install `window.__parseRowKey` / `window.__sessionIdOf` on every page this context
 * loads.
 *
 * Injected with `addInitScript` rather than called after each navigation, because a
 * probe may reload the page and a helper installed by a one-off `evaluate` would be
 * gone for the frames after that — leaving exactly the assertions that run on a
 * refreshed page with no parser.
 *
 * The assignment shape matters. This used to splice the page global into the function text
 * with `PARSE_ROW_KEY_SOURCE.replace('function parseRowKey', 'window.__parseRowKey =
 * function parseRowKey')`, which depends on that exact substring existing: turning the
 * declaration into a `const` arrow, renaming it, or minifying the file would make the
 * `replace` a silent no-op, leaving a bare declaration and no `window.__parseRowKey`, so
 * every probe would fail later with an opaque `window.__sessionIdOf is not a function`.
 * Assigning whole expressions cannot silently do nothing.
 * @param page - the Playwright page to install into.
 * @returns a promise that resolves once the script is registered.
 */
export function installRowKeyHelpers(page) {
  return page.addInitScript([
    // Published under its own name too, because `SESSION_ID_OF_SOURCE` calls it as a bare
    // identifier — see that constant.
    `window.parseRowKey = ${PARSE_ROW_KEY_SOURCE};`,
    'window.__parseRowKey = window.parseRowKey;',
    `window.__sessionIdOf = ${SESSION_ID_OF_SOURCE};`,
  ].join('\n'))
}
