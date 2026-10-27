/**
 * 跨插件 CSS Modules 类名隔离检查。
 *
 * ## 为什么需要这个
 *
 * CSS Modules 的哈希只由传给 lightningcss 的 `filename` 派生。两个插件若都有
 * `src/client/settings-card.module.css`，在各自仓库根目录下 `relative(cwd, abs)`
 * 得到的是同一个字符串，于是哈希相同、类名相同。
 *
 * 两个插件都装着时，两张样式表**同时生效**（注入用的 `tagId` 带包名，只是让它们
 * 不互相覆盖，不负责选择器隔离）。于是 `A` 的规则会命中 `B` 的元素。
 *
 * 实测过一次真实事故：`dsh-auto-expand` 与 `dsh-project-groups` 撞了 10 个类名，
 * 其中 DPG 的 `.section > :first-child { margin-top: -12px }` 落到 auto-expand 的
 * `<h3>` 上，把分组标题从 `section` 顶部 16px 处拽到 4px —— 12px 凭空消失。
 * 只有两个插件同时启用时才会出现，因此极难归因。
 *
 * ## 判据
 *
 * 直接比对本仓库产物与同级其它插件产物的**类名集合**，交集必须为空。
 * 这个判据不依赖任何内部实现细节：只要隔离成立，交集就是空的。
 *
 * 一个同级插件都没有时报告 SKIP 而不是 PASS —— 缺少对照物时"通过"是假象。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SELF_ROOT = resolve(import.meta.dirname, '..')
const PARENT = dirname(SELF_ROOT)

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/**
 * 从构建产物里取出所有 CSS Module 类名。
 *
 * 产物把编译后的 CSS 存成一个 JS 字符串常量，类名形如 `[hash]_[local]`：
 * hash 是 6~8 位（大小写字母、数字、`-`、`_`），local 以字母开头。
 * 只在 CSS 文本里扫，不扫整个 bundle —— 后者会把普通标识符也匹配进来。
 * @param file - `lib/client.js` 的路径。
 * @returns 类名集合。
 */
function classNamesOf(file) {
  const source = readFileSync(file, 'utf8')
  const names = new Set()
  // 产物里每个样式表是一个 JS 字符串字面量，变量名带 rolldown 的去重后缀：
  // `const css = "…"`、`const css$4 = "…"`、`const css$12 = "…"`。
  //
  // 第一版只匹配 `const css = `，于是每个包只看到第一个样式表 —— 本项目有 5 个、
  // auto-expand 有 7 个，却各自只读到一个。漏掉的那几个样式表里的撞名不会被发现，
  // 检查会假绿。这里的正则必须吃掉可选后缀。
  for (const literal of source.matchAll(/const css(\$\d+)? = ("(?:[^"\\]|\\.)*")/g)) {
    let text
    try {
      text = JSON.parse(literal[2])
    } catch {
      continue
    }
    for (const m of text.matchAll(/\.([A-Za-z0-9_-]{6,8})_([A-Za-z][A-Za-z0-9]*)/g)) {
      names.add(`${m[1]}_${m[2]}`)
    }
  }
  return names
}

/**
 * 找出同级目录里其它已构建的插件。
 * @returns `{ name, file }` 列表。
 */
function siblingPlugins() {
  const found = []
  for (const name of readdirSync(PARENT)) {
    if (name === 'node_modules' || name === 'temp' || name === 'backups') continue
    const dir = join(PARENT, name)
    if (!statSync(dir).isDirectory()) continue
    const file = join(dir, 'lib', 'client.js')
    if (resolve(dir) === SELF_ROOT || !existsSync(file)) continue
    // 只认真正的插件包：必须有 package.json 且声明了 client 导出。
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) continue
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    } catch {
      continue
    }
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('dsh-')) continue
    found.push({ name: pkg.name, file })
  }
  return found
}

const selfName = JSON.parse(readFileSync(join(SELF_ROOT, 'package.json'), 'utf8')).name
const selfFile = join(SELF_ROOT, 'lib', 'client.js')

if (!existsSync(selfFile)) {
  console.error(`未找到构建产物：${selfFile}`)
  console.error('先跑 pnpm build 再来。')
  process.exit(2)
}

const selfClasses = classNamesOf(selfFile)
console.log(`${selfName}：${selfClasses.size} 个 CSS Module 类名`)
check('本插件产物里取到了类名', selfClasses.size > 0, String(selfClasses.size))

const siblings = siblingPlugins()
if (siblings.length === 0) {
  console.log('')
  console.log('SKIP  同级目录没有其它已构建的 dsh 插件 —— 缺少对照物，隔离性未验证')
} else {
  for (const sibling of siblings) {
    const other = classNamesOf(sibling.file)
    if (other.size === 0) {
      console.log(`SKIP  ${sibling.name} 的产物里没有 CSS Module 类名`)
      continue
    }
    const shared = [...selfClasses].filter(name => other.has(name)).sort()
    console.log('')
    console.log(`${sibling.name}：${other.size} 个 CSS Module 类名`)
    check(
      `与 ${sibling.name} 的类名无交集`,
      shared.length === 0,
      shared.length === 0 ? '交集为空' : `${shared.length} 个撞名：${shared.slice(0, 12).join(', ')}${shared.length > 12 ? ' …' : ''}`,
    )
    if (shared.length > 0) {
      console.log('')
      console.log('  撞名意味着两个插件的样式会互相作用。修法：给哈希输入加包名，')
      console.log('  让 tsdown.config.ts 里传 filename: `${PACKAGE_NAME}/${identity}`。')
    }
  }
}

console.log('')
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
