/**
 * Behaviour test for the project row's own context-menu target family.
 *
 * ## Why this exists
 *
 * A project is a **label, not a directory**: it has no `workspaceId` and no `cwd`, so
 * upstream's workspace menu trigger (which needs both) is always undefined for it, and
 * reusing `target: 'workspace'` would show only the *first* of a project's directories —
 * upstream's `resolve` reads the single `target.value.path`. Task 5 therefore registers a
 * new `target: 'project'` family, and the load-bearing part of it is the three-state
 * `reveal` rule:
 *
 *   - **0 directories** — a project may be a pure label. A "show in folder" row with no
 *     folder is an action that can only fail, so it is not produced at all.
 *   - **1 directory**  — one row that runs directly, with **no** `children`. A submenu of
 *     one would be a needless extra hover, and the context-menu layer refuses to select a
 *     row that carries `children`.
 *   - **N directories** — one parent row whose `children` are the directories, in their
 *     stored order, labelled with the raw path.
 *
 * ## Why it is asserted against the real module
 *
 * `src/client/project-menu.ts` is imported, not copied. It carries no value imports at
 * all (only `import type`), so Node's type stripping loads it with no module stubs — which
 * is also why the module must stay value-import-free: the moment it imports an icon or a
 * React helper, this test would need the client bundle's globals to run.
 *
 * The three-state rule is the kind of logic that reads as obviously correct and then
 * quietly loses a directory: `children` built with `slice(1)` instead of a full `map`, or
 * a parent row that also carries `run`, both look right in a diff and break the menu.
 */

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

/**
 * Load the module under test, reporting a failure rather than throwing.
 *
 * This is the RED step's whole point when the file does not exist yet: an unhandled
 * `ERR_MODULE_NOT_FOUND` would abort with a raw stack and no summary, which reads as a
 * harness crash rather than as the expected failure.
 */
let menu
try {
  menu = await import('../src/client/project-menu.ts')
} catch (error) {
  check('可以载入 src/client/project-menu.ts', false, String(error?.message ?? error).slice(0, 200))
}
if (failures.length > 0) {
  console.log('')
  console.log(`${failures.length} CHECK(S) FAILED`)
  process.exit(1)
}

const { projectMenuActions } = menu

/** What the menu asked for, recorded so the assertions can read it after the fact. */
const calls = []
const recordingActions = {
  rename: id => { calls.push(['rename', id]) },
  remove: id => { calls.push(['remove', id]) },
  reveal: async path => { calls.push(['reveal', path]) },
}

/**
 * Identity translation: every label is asserted through the key that produced it, so a
 * copy change does not touch this file. The submenu labels are the one place a key would
 * be wrong — they are the raw directory, asserted verbatim below.
 * @param key - locale key.
 * @returns the key itself.
 */
const t = key => key

/**
 * The three contributions' actions for one target, in menu order.
 *
 * Mirrors what the context-menu layer does at open time: every contribution targeting
 * `project` resolves against the same captured target, and the popup orders the results by
 * each contribution's `order` (rename 100, reveal 200, remove 300).
 * @param patch - target fields to override; `directories` defaults to none.
 * @returns the merged action list.
 */
const actionsFor = (patch = {}) => projectMenuActions(
  { projectId: 'p1', title: '项目', directories: [], ...patch },
  recordingActions,
  t,
)

console.log('=== 1. 零目录：不产出「在文件夹中显示」，其余两项照旧 ===')
{
  const actions = actionsFor({ directories: [] })
  check('没有 reveal 动作', actions.some(a => a.id === 'reveal') === false, JSON.stringify(actions.map(a => a.id)))
  check('rename 仍然存在', actions.some(a => a.id === 'rename'), JSON.stringify(actions.map(a => a.id)))
  check('remove 仍然存在', actions.some(a => a.id === 'remove'), JSON.stringify(actions.map(a => a.id)))
  check('恰好两个动作', actions.length === 2, String(actions.length))
}

console.log('')
console.log('=== 2. 单目录：直接可用，且不可有 children ===')
{
  const one = actionsFor({ directories: ['C:/a'] }).find(a => a.id === 'reveal')
  check('reveal 动作存在', one !== undefined)
  check('没有 children', one?.children === undefined, JSON.stringify(one?.children))
  check('label 是文案键而非目录', one?.label === 'menu.reveal', JSON.stringify(one?.label))
  // The row must actually be selectable: the context-menu layer skips a row that carries
  // `children`, so a single directory with an (empty) children array would be dead.
  check('有 run 回调', typeof one?.run === 'function')
  // `reveal` is the only verb that can reject, and the menu layer reports a rejection as
  // `notify(failureLabel ?? t('failed'))`. Without this field the user would read the
  // generic "operation failed, try again" instead of the copy naming the likely cause, so
  // the field is load-bearing rather than decorative.
  check('带 failureLabel（reject 时不落回通用文案）', one?.failureLabel === 'menu.reveal.failed',
    String(one?.failureLabel))
  calls.length = 0
  await one?.run?.()
  check('run 收到那个目录', JSON.stringify(calls) === JSON.stringify([['reveal', 'C:/a']]), JSON.stringify(calls))
}

console.log('')
console.log('=== 3. 多目录：children 数量与顺序都与 directories 一致 ===')
{
  const many = actionsFor({ directories: ['C:/a', 'C:/b', 'C:/c'] }).find(a => a.id === 'reveal')
  check('reveal 动作存在', many !== undefined)
  check('children 数量等于目录数', many?.children?.length === 3, String(many?.children?.length))
  check('children 的 label 是目录原文且顺序不变',
    JSON.stringify(many?.children?.map(c => c.label)) === JSON.stringify(['C:/a', 'C:/b', 'C:/c']),
    JSON.stringify(many?.children?.map(c => c.label)))
  check('children 的 id 是 reveal:<index>',
    JSON.stringify(many?.children?.map(c => c.id)) === JSON.stringify(['reveal:0', 'reveal:1', 'reveal:2']),
    JSON.stringify(many?.children?.map(c => c.id)))
  // A parent that also carries `run` is a contradiction: the layer never calls it, so the
  // click would look like it did nothing. Absent is the only honest shape.
  check('父项没有 run（只能展开，不能被选中）', many?.run === undefined, String(typeof many?.run))
  // The layer reads `failureLabel` off the **selected leaf**, not off the parent it was
  // reached through, so a parent-only label would still leave every child falling back to
  // the generic notice.
  check('每个子项都带 failureLabel',
    (many?.children ?? []).every(child => child.failureLabel === 'menu.reveal.failed'),
    JSON.stringify((many?.children ?? []).map(child => child.failureLabel)))

  calls.length = 0
  for (const child of many?.children ?? []) await child.run?.()
  check('每个子项 run 到自己那个目录',
    JSON.stringify(calls) === JSON.stringify([['reveal', 'C:/a'], ['reveal', 'C:/b'], ['reveal', 'C:/c']]),
    JSON.stringify(calls))
}

console.log('')
console.log('=== 4. 顺序固定为 rename / reveal / remove，remove 是危险项且有分隔线 ===')
{
  const ids = actionsFor({ directories: ['C:/a'] }).map(a => a.id)
  check('顺序是 rename → reveal → remove',
    JSON.stringify(ids) === JSON.stringify(['rename', 'reveal', 'remove']), JSON.stringify(ids))

  const remove = actionsFor({ directories: ['C:/a'] }).find(a => a.id === 'remove')
  check('remove 标了 danger', remove?.danger === true, String(remove?.danger))
  check('remove 标了 separatorBefore', remove?.separatorBefore === true, String(remove?.separatorBefore))
  // Only `remove` gets a separator: a hairline above reveal would split rename from its
  // sibling view action, and a hairline above rename would draw before the first row.
  const others = actionsFor({ directories: ['C:/a'] }).filter(a => a.id !== 'remove')
  check('其余动作没有 separatorBefore', others.every(a => a.separatorBefore !== true),
    JSON.stringify(others.map(a => [a.id, a.separatorBefore])))
  check('零目录时 remove 仍然带分隔线',
    actionsFor({ directories: [] }).find(a => a.id === 'remove')?.separatorBefore === true)
}

console.log('')
console.log('=== 5. rename / remove 转到调用方提供的动词 ===')
{
  calls.length = 0
  await actionsFor({ directories: [] }).find(a => a.id === 'rename')?.run?.()
  check('rename 收到项目 id', JSON.stringify(calls) === JSON.stringify([['rename', 'p1']]), JSON.stringify(calls))

  calls.length = 0
  await actionsFor({ directories: [] }).find(a => a.id === 'remove')?.run?.()
  check('remove 收到项目 id', JSON.stringify(calls) === JSON.stringify([['remove', 'p1']]), JSON.stringify(calls))
}

console.log('')
console.log('=== 6. 目录数据形状未被改动 ===')
{
  // The spec explicitly rejected primary/secondary markers: a project's directories are a
  // plain string list with no ordering semantics beyond display order. A resolved action
  // must therefore read the list it was given and never invent structure.
  const target = { projectId: 'p1', title: '项目', directories: ['C:/x', 'C:/y'] }
  const actions = projectMenuActions(target, recordingActions, t)
  check('resolve 不改写传入的目录数组',
    JSON.stringify(target.directories) === JSON.stringify(['C:/x', 'C:/y']), JSON.stringify(target.directories))
  check('children 只是目录的映射，没有附加字段',
    (actions.find(a => a.id === 'reveal')?.children ?? []).every(child =>
      JSON.stringify(Object.keys(child).sort()) === JSON.stringify(['failureLabel', 'id', 'label', 'run'])),
    JSON.stringify((actions.find(a => a.id === 'reveal')?.children ?? []).map(child => Object.keys(child).sort())))
}

console.log('')
if (failures.length === 0) {
  console.log('ALL CHECKS PASSED')
} else {
  console.log(`${failures.length} CHECK(S) FAILED:`)
  for (const failure of failures) console.log(`  ${failure}`)
  process.exitCode = 1
}
