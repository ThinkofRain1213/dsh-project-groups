/**
 * Behaviour test for the locale maps.
 *
 * A missing key is invisible at runtime: the lookup returns `undefined`, React
 * renders nothing, and every existing probe still passes because they assert on
 * the strings they DO expect. It reached a release-shaped state once already —
 * three keys were defined in both languages and referenced nowhere, and two of
 * them were leftovers of a design that had been deleted.
 *
 * Three checks, in order of how much damage the failure does:
 *
 *   1. **Parity** — a key in one language but not the other. The worst of the
 *      three, because the UI is then half-translated in exactly one locale.
 *   2. **Dead keys** — defined, never referenced. Not a user-visible bug, but it
 *      is how a removed design keeps looking alive, and the next reader has to
 *      re-derive whether the key still matters.
 *   3. **Placeholders** — `{name}`-style slots must match across languages, or one
 *      locale interpolates a value the other silently drops.
 *
 * Both maps are read from source rather than imported, because they are plain
 * object literals inside modules that also import React and CSS; parsing them
 * keeps this test runnable without the client bundle.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/** Every `.ts`/`.tsx` under a directory, excluding build output. */
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'lib') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** `{slot}` names inside one message. */
const slotsOf = (text) => new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]))

/**
 * Compare one locale pair.
 *
 * `zhMarker` / `enMarker` locate the two object literals; the second runs to the
 * end of the file. Keys are matched on `  name:` at two-space indent, which is how
 * both files are written.
 */
function compare({ label, file, zhMarker, enMarker, flat, sourceFiles }) {
  console.log('')
  console.log(`=== ${label} ===`)
  const text = readFileSync(file, 'utf8')
  const zhStart = text.indexOf(zhMarker)
  const enStart = text.indexOf(enMarker, zhStart)
  if (zhStart < 0 || enStart < 0) {
    check(`${label}: 找到两个语言块`, false, `zh=${zhStart} en=${enStart}`)
    return
  }
  const zhBody = text.slice(zhStart, enStart)
  const enBody = text.slice(enStart)

  // Flat maps are `'a.b': value`; nested ones are `  name: value`.
  //
  // The value may be quoted with EITHER quote character: several English strings
  // contain an apostrophe ("The current Session's project") and are therefore
  // double-quoted, while their Chinese counterparts are single-quoted. Matching
  // only `'...'` reported those as missing from `en` — three false failures that
  // looked exactly like a real parity bug.
  const value = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')`
  const re = flat
    ? new RegExp(String.raw`^\s{2}'([^']+)'\s*:\s*${value}`, 'gm')
    : new RegExp(String.raw`^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:\s*${value}`, 'gm')
  const grab = (body) => {
    const out = new Map()
    for (const m of body.matchAll(re)) out.set(m[1], m[2] ?? m[3] ?? '')
    return out
  }
  const zh = grab(zhBody)
  const en = grab(enBody)
  console.log(`  ${label}: zh=${zh.size} en=${en.size}`)

  // 1. Parity.
  const onlyZh = [...zh.keys()].filter(k => !en.has(k))
  const onlyEn = [...en.keys()].filter(k => !zh.has(k))
  check(`${label}: 两个语言键位一致`, onlyZh.length === 0 && onlyEn.length === 0,
    `只在 zh: ${JSON.stringify(onlyZh)} / 只在 en: ${JSON.stringify(onlyEn)}`)

  // 3. Placeholder parity.
  const slotMismatch = []
  for (const [key, zhText] of zh) {
    const enText = en.get(key)
    if (enText === undefined) continue
    const a = [...slotsOf(zhText)].sort().join(',')
    const b = [...slotsOf(enText)].sort().join(',')
    if (a !== b) slotMismatch.push(`${key}: zh{${a}} en{${b}}`)
  }
  check(`${label}: 占位符两侧一致`, slotMismatch.length === 0, slotMismatch.join(' | '))

  // 2. Dead keys: defined in zh, never referenced by any source file.
  const all = sourceFiles.map(f => readFileSync(f, 'utf8')).join('\n')
  const dead = [...zh.keys()].filter(k => !all.includes(`'${k}'`) && !all.includes(`"${k}"`))
  check(`${label}: 无死键`, dead.length === 0, JSON.stringify(dead))
}

const srcFiles = sources('src')
compare({
  label: '设置卡',
  file: join('src', 'client', 'settings-locales.ts'),
  zhMarker: 'const zh = {',
  enMarker: 'const en',
  flat: false,
  sourceFiles: srcFiles,
})
compare({
  label: '浏览器',
  file: join('src', 'vendored', 'client', 'locales.ts'),
  zhMarker: 'const zh',
  enMarker: 'const en',
  flat: true,
  sourceFiles: srcFiles,
})

console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
