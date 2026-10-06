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

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const version = pkg.version
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const zhLocale = JSON.parse(readFileSync('locale/zh.json', 'utf8'))
const enLocale = JSON.parse(readFileSync('locale/en.json', 'utf8'))
const zh = readFileSync('README.md', 'utf8')
const en = readFileSync('README.en.md', 'utf8')

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
check('没有未发布的占位段', !/\[(未发布|Unreleased)\]/i.test(changelog))

console.log('')
console.log('=== 2. locale 描述（插件列表显示的文案）===')
for (const [name, meta] of [['zh', zhLocale.meta], ['en', enLocale.meta]]) {
  console.log(`  ${name}: ${meta.title} — ${meta.description.slice(0, 48)}…`)
  check(`${name} 有 title 与 description`, meta.title !== '' && meta.description !== '')
  check(`${name} 描述提到文档能力`, /文档|document/.test(meta.description))
  check(`${name} 描述说明可逆（关掉恢复官方）`,
    /恢复官方|restores the official/.test(meta.description))
}
check('两版 title 各自本地化', zhLocale.meta.title !== enLocale.meta.title)
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
for (const entry of ['lib', 'src', 'spec', 'locale/*.json', 'cordis.patch.yml',
  'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE']) {
  check(`files 含 ${entry}`, pkg.files.includes(entry))
}
check('description 提到文档能力', /document/.test(pkg.description))
check('keywords 是数组且非空', Array.isArray(pkg.keywords) && pkg.keywords.length > 0)
check('repository / homepage / bugs / license 齐备',
  pkg.repository !== undefined && pkg.homepage !== undefined
  && pkg.bugs !== undefined && pkg.license === 'MIT')

console.log('')
console.log('=== 5. 打包清单（pnpm pack --dry-run）===')
try {
  const out = execFileSync('pnpm', ['pack', '--dry-run'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true,
  })
  const named = /dsh-project-groups-([0-9.]+)\.tgz/.exec(out)
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

console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
