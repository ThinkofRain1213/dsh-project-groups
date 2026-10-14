/**
 * Masking the dev-server token wherever a probe echoes captured output.
 *
 * A probe learns its URL by scraping `dsh web: http://127.0.0.1:<port>/?token=<uuid>`
 * out of the spawned Host's stdout. That URL is a live credential: whoever holds it
 * can drive the instance. So every path that prints captured stdout — a boot
 * timeout being the common one, since that is exactly when the reader wants the
 * output — must mask the token first.
 *
 * This exists as one function rather than a regex per probe because the leak was
 * found in **33 of them** with the same shape:
 *
 *     reject(new Error(`boot timeout:\n${out.slice(-1500)}`))
 *
 * Thirty-three copies of a security rule is thirty-three chances to forget it, and
 * a new probe would start from whichever neighbour it was copied from. One helper
 * means the rule has one home.
 *
 * The regex matches any `token=<value>` query parameter, not just the dev-server
 * URL shape, so it also covers a token that arrives in some other message a probe
 * happens to echo. `\S` rather than a UUID pattern: the value's alphabet is not
 * this module's business, and stopping at whitespace keeps the surrounding text
 * readable in the log.
 */

/** What a masked token looks like. Fixed width: the real length is not a secret. */
export const REDACTED = 'token=***'

/**
 * Replace every `token=<value>` in a string with {@link REDACTED}.
 *
 * Case-insensitive on the parameter name: query parameters are conventionally
 * lowercase but the name is not guaranteed to be.
 * @param text - captured output, a URL, or any diagnostic string.
 * @returns the same string with each token value masked.
 */
export function redactToken(text) {
  return String(text).replace(/token=[^\s&"']+/gi, REDACTED)
}

/**
 * {@link redactToken} for `console.log`-style argument lists.
 *
 * A probe that logs a URL alongside other fields would otherwise need to wrap each
 * one; this keeps the call site to a single rename.
 * @param args - values about to be printed.
 * @returns the same values, stringified and masked.
 */
export function redactArgs(args) {
  return args.map(redactToken)
}
