/**
 * Assert the settings card's vertical rhythm against the values the spec fixes.
 *
 * ## Why a static check on the stylesheet rather than only a rendered probe
 *
 * The rhythm is four numbers, and every one of them can be wrong in a way that
 * still renders: 16 vs 12 reads as "slightly roomier", an 8px group gap reads as
 * "a bit more space under the heading". A rendered probe catches those only if it
 * measures the exact boxes, and it needs a real DSH instance, so it cannot run in
 * CI. This file reads the stylesheet and pins the numbers, so a careless edit
 * fails in the gate instead of shipping a card that looks subtly wrong.
 *
 * The rendered half lives in `probe-settings-rhythm.mjs`, which measures the
 * computed boxes on a real instance. Neither replaces the other: this one proves
 * the declared values, that one proves they compose into the intended gaps.
 *
 * Usage: node scripts/verify-settings-rhythm.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = await readFile(join(ROOT, 'src/client/settings-card.module.css'), 'utf8')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * One class selector's declaration block, or `undefined` when the class is gone.
 *
 * Escaped rather than interpolated raw: the selectors here start with `.`, which a
 * regex would read as "any character", so `rule('.row')` would also match
 * `.arrow` and silently pass on the wrong block.
 * @param selector - the class selector including its leading dot.
 * @returns the text between the braces, or undefined.
 */
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  return match?.[1]
}

const rowBody = rule('.row')
const groupBody = rule('.group')
const sectionBody = rule('.section')

check('.row padding 是 12px 0', /padding:\s*12px\s+0/.test(rowBody ?? ''), rowBody?.trim())
check('.group gap 是 6px', /gap:\s*6px/.test(groupBody ?? ''), groupBody?.trim())
check('.group padding 是 12px 0', /padding:\s*12px\s+0/.test(groupBody ?? ''), groupBody?.trim())
check('.section padding 是 16px 0', /padding:\s*16px\s+0/.test(sectionBody ?? ''), sectionBody?.trim())

// The negative margins are what make 16px the boundary's only source. A direct
// child selector is required: `.group`'s own first child also carries 12px, and an
// unqualified `:first-child` would drag it up by 12.
check('.section 用直接子选择器吃掉首块上 padding',
  /\.section\s*>\s*:first-child\s*\{[^}]*margin-top:\s*-12px/.test(css))
check('.section 用直接子选择器吃掉末块下 padding',
  /\.section\s*>\s*:last-child\s*\{[^}]*margin-bottom:\s*-12px/.test(css))

check('.groupHeading 已删除', rule('.groupHeading') === undefined)

// A guard on the value that must NOT move: `.cube`'s internal 4px is card-internal
// layout, not a title/description relationship, so the "one 6px" rule does not
// apply to it. Without this, a sweep that replaces every small gap would take it.
check('.cube 的 gap 仍是 4px（未被误改）', /\.cube\s*\{[^}]*gap:\s*4px/s.test(css))

// The title/description pairs must agree. `.rowText` was already 6; this pins it so
// a future edit cannot make the two shapes drift apart again.
check('.rowText gap 仍是 6px', /\.rowText\s*\{[^}]*gap:\s*6px/s.test(css))

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
