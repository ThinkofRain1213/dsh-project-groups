/**
 * Behaviour test for release readiness.
 *
 * A release touches facts no other check covers, and every one of them has been
 * wrong at least once in this repository's short history:
 *
 *   1. **version agreement** — package.json, CHANGELOG, and the tarball name must
 *      name the same version;
 *   2. **locale descriptions** — what the plugin list shows. `README.md` was
 *      rewritten for the document feature while these still described the plugin
 *      as grouping-only, which is the copy users actually read;
 *   3. **README parity** — the two languages had drifted apart (one claimed 362
 *      assertions, the other 354), so the pair is compared structurally;
 *   4. **pack contents** — `files` must ship what the release adds (the changelog
 *      was missing from it), and must not ship `scripts/`;
 *   5. **no accidentally committed artifacts** — a stray `.tgz` or scratch script.
 *
 * Everything is derived from `package.json`, so bumping the version makes this
 * fail until the CHANGELOG section exists — which is the intended discipline.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/**
 * Read and parse every release input, reporting a failed check rather than throwing.
 *
 * These reads used to run bare at the top of the file, so a missing `CHANGELOG.md` or a
 * malformed `locale/zh.json` — both of which this script exists to catch — produced a raw
 * `ENOENT`/`SyntaxError` stack trace and no `PASS`/`FAIL` line at all. A gate that crashes
 * without saying what it was checking reads as a broken script, not as a failed release.
 * @returns whether every input loaded.
 */
function loadInputs() {
  try {
    pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    version = pkg.version
    changelog = readFileSync('CHANGELOG.md', 'utf8')
    zhLocale = JSON.parse(readFileSync('locale/zh.json', 'utf8'))
    enLocale = JSON.parse(readFileSync('locale/en.json', 'utf8'))
    zh = readFileSync('README.md', 'utf8')
    en = readFileSync('README.en.md', 'utf8')
    return true
  } catch (error) {
    check('可以读取并解析全部发布输入', false, String(error.message ?? error).slice(0, 200))
    return false
  }
}

let pkg
let version
let changelog
let zhLocale
let enLocale
let zh
let en
if (!loadInputs()) {
  console.log('')
  console.log('1 CHECK(S) FAILED')
  process.exit(1)
}

console.log('=== 1. 版本号一致 ===')
console.log(`  package.json: ${version}`)
check('是合法的 x.y.z', /^\d+\.\d+\.\d+$/.test(version), version)
check('CHANGELOG 有该版本段落', changelog.includes(`## [${version}]`), `## [${version}]`)
check('CHANGELOG 定义了该版本的链接', changelog.includes(`[${version}]:`))
// The newest entry must be the version being released, or the changelog is stale.
{
  const first = /^## \[([^\]]+)\]/m.exec(changelog)?.[1]
  check('CHANGELOG 最新一段就是当前版本', first === version, `最新=${first} 版本=${version}`)
}
// Anchored to a heading, not any bracketed occurrence. The unanchored form also matched a link
// definition or a sentence that merely mentioned `[Unreleased]`, so it could fail on a
// changelog that had no such section.
check('没有未发布的占位段', !/^##\s*\[(未发布|Unreleased)\]/im.test(changelog))

console.log('')
console.log('=== 2. locale 描述（插件列表显示的文案）===')
for (const [name, meta] of [['zh', zhLocale.meta], ['en', enLocale.meta]]) {
  // Every read below is optional-chained and type-checked. The block used to dereference
  // `meta.title` in the log line and `meta.description` in four assertions, so a locale file
  // that had lost its `meta` object — exactly what a rename or a bad merge produces — threw a
  // `TypeError` out of the script instead of reporting which locale was malformed.
  const title = typeof meta?.title === 'string' ? meta.title : undefined
  const description = typeof meta?.description === 'string' ? meta.description : undefined
  console.log(`  ${name}: ${title ?? '(缺少 meta.title)'} — ${(description ?? '(缺少 meta.description)').slice(0, 48)}…`)
  check(`${name} 有 meta.title`, title !== undefined && title !== '')
  check(`${name} 有 meta.description`, description !== undefined && description !== '')
  check(`${name} 描述提到文档能力`, /文档|document/.test(description ?? ''))
  check(`${name} 描述说明可逆（关掉恢复官方）`,
    /恢复官方|restores the official/.test(description ?? ''))
}
check('两版 title 各自本地化',
  typeof zhLocale.meta?.title === 'string' && zhLocale.meta.title !== enLocale.meta?.title)
// No length cap is asserted on purpose: measurement showed the surfaces that
// render these (`detailDesc` 960px, `rowModule` 777px) do not clamp, and the
// natural height equalled the content height at the shipped length. A cap would
// be a number invented here rather than a constraint of the surface.

console.log('')
console.log('=== 3. 两版 README 结构对等 ===')
{
  const heads = (t) => [...t.matchAll(/^(#{1,3}) (.+)$/gm)].map(m => m[1].length)
  const a = heads(zh)
  const b = heads(en)
  console.log(`  中文 ${a.length} 个标题, 英文 ${b.length} 个`)
  check('标题数量一致', a.length === b.length, `${a.length} vs ${b.length}`)
  check('标题层级序列一致', a.join(',') === b.join(','), `${a.join(',')} vs ${b.join(',')}`)
  check('两版互指对方', zh.includes('README.en.md') && en.includes('README.md'))
  check('两版都写了发布步骤', /### 发布/.test(zh) && /### Releasing/.test(en))
}

console.log('')
console.log('=== 4. files 字段 ===')
// `pkg.files` was dereferenced with `.includes` directly, so a manifest whose `files` was
// missing or had become a string threw a TypeError instead of reporting that the field is
// wrong — the one thing this block is for.
const shipped = Array.isArray(pkg.files) ? pkg.files : []
check('files 是数组', Array.isArray(pkg.files), typeof pkg.files)
for (const entry of ['lib', 'src', 'spec', 'locale/*.json', 'cordis.patch.yml',
  'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE']) {
  check(`files 含 ${entry}`, shipped.includes(entry))
}
check('description 提到文档能力', /document/.test(pkg.description))
check('keywords 是数组且非空', Array.isArray(pkg.keywords) && pkg.keywords.length > 0)
check('repository / homepage / bugs / license 齐备',
  pkg.repository !== undefined && pkg.homepage !== undefined
  && pkg.bugs !== undefined && pkg.license === 'MIT')

console.log('')
console.log('=== 5. 打包清单（pnpm pack --dry-run）===')
try {
  // One command string, no args array, and that is deliberate.
  //
  // Measured on Windows: `execFileSync('pnpm', [...])` without a shell fails with ENOENT
  // (there is no `pnpm.exe`, only `pnpm.cmd`) and `execFileSync('pnpm.cmd', [...])` fails with
  // EINVAL, because Node cannot exec a `.cmd` itself — so the shell is not optional here. But
  // `shell: true` **with** an args array is what Node now deprecates (DEP0190: the arguments
  // are concatenated, not escaped), and it emitted that warning on every run. Passing the whole
  // command as one string is the form Node still supports; it is safe because the command is a
  // fixed literal with no interpolation, so there is nothing for a shell to re-interpret.
  const out = execFileSync('pnpm pack --dry-run', {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true,
  })
  // Built from `pkg.name` rather than a literal, so renaming the package cannot leave this
  // regex matching the old name and reporting a mystery failure.
  const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const named = new RegExp(`${escaped}-([0-9.]+)\\.tgz`).exec(out)
  check('产物名带当前版本号', named?.[1] === version, String(named?.[1]))
  for (const want of ['CHANGELOG.md', 'README.md', 'README.en.md', 'spec/PROJECT-SPEC.md',
    'spec/REWRITE-FLOW.md', 'locale/zh.json', 'locale/en.json', 'lib/index.js', 'lib/client.js',
    'cordis.patch.yml', 'LICENSE']) {
    check(`包内列出 ${want}`, out.includes(want))
  }
  // The scripts tree is development-only, and shipping it would publish the probes.
  const unwanted = out.split('\n').filter(l => /^scripts\/|node_modules/.test(l.trim()))
  check('包内不含 scripts/ 或 node_modules', unwanted.length === 0,
    JSON.stringify(unwanted.slice(0, 4)))
} catch (error) {
  check('pnpm pack --dry-run 可运行', false, String(error).slice(0, 200))
}

console.log('')
console.log('=== 6. 工作区没有误提交的产物 ===')
{
  const strays = readdirSync('.').filter(n => /\.tgz$/.test(n) || /^_.*\.mjs$/.test(n))
  check('仓库根目录无 .tgz / 临时脚本', strays.length === 0, JSON.stringify(strays))
  check('CHANGELOG.md 存在且被 files 收录', existsSync('CHANGELOG.md') && pkg.files.includes('CHANGELOG.md'))
}

console.log('=== 7. pnpm 豁免表与 lockfile 的 dsh 集合一致 ===')
{
  // `pnpm-workspace.yaml` hard-codes the exact version `0.2.0-rc.2` for every entry, so bumping
  // the DSH version in one place and not the other makes `pnpm install` fail the release-age
  // check for dozens of packages at once — with an error that names none of them as the cause.
  //
  // The list is compared against the **lockfile**, not against `devDependencies`. That was the
  // review's suggestion and it is wrong for this repository: `minimumReleaseAgeExclude` has to
  // cover every package pnpm resolves, and 49 of the 75 entries are transitive dependencies of
  // the DSH packages rather than direct ones. Asserting equality with `devDependencies` fails
  // immediately, and a one-directional "every devDependency is exempt" check would pass while
  // the transitive half silently rotted. Measured: the exempt set and the lockfile's
  // `@deepseek-ai/dsh-*` set are exactly equal, 75 either way.
  const workspace = readFileSync('pnpm-workspace.yaml', 'utf8')
  const lockfile = readFileSync('pnpm-lock.yaml', 'utf8')
  const exempt = [...workspace.matchAll(/^ {2}- '([^']+)'$/gm)].map(m => m[1])
  // The package name without its trailing `@version`.
  const nameOf = entry => entry.replace(/@[^@]*$/, '')
  const versionOf = entry => entry.slice(nameOf(entry).length + 1)

  const exemptByName = new Map(exempt.map(e => [nameOf(e), versionOf(e)]))
  const inLock = new Map()
  for (const m of lockfile.matchAll(/^ {2}(@deepseek-ai\/dsh-[a-z0-9-]+):/gm)) inLock.set(m[1], null)
  for (const m of lockfile.matchAll(/'(@deepseek-ai\/dsh-[a-z0-9-]+)@([^']+)'/g)) {
    if (!inLock.has(m[1])) inLock.set(m[1], m[2])
  }

  const declared = Object.keys(pkg.devDependencies ?? {}).filter(n => n.startsWith('@deepseek-ai/dsh-'))

  check('pnpm 豁免表非空', exempt.length > 0, String(exempt.length))
  check('pnpm 豁免表覆盖全部直接 dsh 依赖',
    declared.every(n => exemptByName.has(n)),
    JSON.stringify(declared.filter(n => !exemptByName.has(n)).sort()))
  check('pnpm 豁免表覆盖 lockfile 的全部 dsh 包',
    [...inLock.keys()].every(n => exemptByName.has(n)),
    JSON.stringify([...inLock.keys()].filter(n => !exemptByName.has(n)).sort()))
  check('pnpm 豁免表没有 lockfile 中不存在的 dsh 条目',
    [...exemptByName.keys()].every(n => inLock.has(n)),
    JSON.stringify([...exemptByName.keys()].filter(n => !inLock.has(n)).sort()))
  // The version is the part that breaks: an exempt entry for a version `pnpm install` no longer
  // resolves protects nothing, and the failure surfaces as an unrelated release-age error.
  const versionMismatch = [...exemptByName.entries()]
    .filter(([name, version]) => inLock.get(name) !== null && inLock.get(name) !== version)
    .map(([name, version]) => `${name}: exempt=${version} lockfile=${inLock.get(name)}`)
  check('pnpm 豁免版本与 lockfile 一致', versionMismatch.length === 0,
    JSON.stringify(versionMismatch.slice(0, 5)))
  // A duplicate is invisible in review and usually means one entry replaced another.
  check('pnpm 豁免表无重复条目', new Set(exempt).size === exempt.length,
    `entries=${exempt.length} unique=${new Set(exempt).size}`)
  // Sorted by package name, so a base package precedes its suffixed siblings
  // (`dsh-session-format` before `dsh-session-format-catalog`). A plain string sort does not:
  // the `@` ending a name sorts after the `-` starting a suffix.
  const sorted = [...exempt].sort((a, b) => {
    const an = nameOf(a), bn = nameOf(b)
    if (an !== bn) return an < bn ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
  })
  check('pnpm 豁免表按包名有序', JSON.stringify(exempt) === JSON.stringify(sorted),
    String(exempt.find((e, i) => e !== sorted[i]) ?? ''))
}

console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
