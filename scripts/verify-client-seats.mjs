/**
 * Unit test for the seats in `src/client/grouping.ts`.
 *
 * ## Why this exists
 *
 * Every seat in that module hands out a disposer. Until this test, none of them was
 * covered: `verify-grouping.mjs` exercises `deriveGroups`, a pure function in the
 * vendored tree, and says nothing about the seat lifecycle. So a real leak lived there
 * unnoticed — `installProjectModel` re-subscribed early listeners onto the live model and
 * **discarded the returned unsubscribe**, so the caller's disposer only ever removed an
 * entry from a set that had already been cleared. The listener stayed attached to the
 * live observable for the lifetime of the page: a component that unmounted after the
 * baseline landed kept being notified.
 *
 * ## Why each case imports its own copy of the module
 *
 * `grouping.ts` keeps its model and its listener sets in module scope, deliberately —
 * there is one browser-side model per page. That makes the pre-model window a
 * one-shot state: once any case calls `installProjectModel`, the module is no longer in
 * the state the next case needs. A cache-busting query string gives each case a fresh
 * module instance (verified: two different query strings yield two different exports),
 * which is the only way to test "subscribed before the baseline" more than once.
 *
 * The assertions are written so the pre-fix code fails them: subscribe while the model is
 * absent, install the model, dispose, then notify. Under the old code the disposed
 * listener still fires.
 */

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

let moduleCounter = 0
/** A fresh, un-installed module instance — one per case. */
const freshGrouping = async () => {
  moduleCounter += 1
  return import(`../src/client/grouping.ts?case=${String(moduleCounter)}`)
}

/** A minimal HostObservable: keeps its listeners so a test can fire and count them. */
function fakeObservable(initial) {
  const listeners = new Set()
  let value = initial
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Test-only: how many listeners are attached right now. */
    listenerCount: () => listeners.size,
    /** Test-only: replace the value and fire every attached listener. */
    emit: (next) => { value = next; for (const listener of [...listeners]) listener() },
  }
}

/**
 * A `ProjectModel` stand-in carrying only the seats the module reads.
 *
 * Structural rather than the real class: the module only ever calls these members, and
 * building the real model needs a Remote namespace this test has no interest in.
 */
function fakeModel() {
  return {
    grouping: fakeObservable(['g']),
    expansions: fakeObservable({}),
    orders: fakeObservable({}),
    newSessionTarget$: fakeObservable('ungrouped'),
    baseWorkspace$: fakeObservable({ mode: 'default' }),
    createOpensSession$: fakeObservable(true),
    injectProjectInfo$: fakeObservable(true),
    injectProjectDoc$: fakeObservable(false),
    target: () => 'ungrouped',
    baseWorkspaceSetting: () => ({ mode: 'default' }),
    createOpensSessionValue: () => true,
    injectProjectInfoValue: () => true,
    injectProjectDocValue: () => false,
    docSpecMode$: fakeObservable('default'),
    docSpecFileName$: fakeObservable(''),
    perProjectDocSpec$: fakeObservable(false),
    validateLinks$: fakeObservable(true),
    specs$: fakeObservable([]),
    docSpecModeValue: () => 'default',
    docSpecFileNameValue: () => '',
    perProjectDocSpecValue: () => false,
    validateLinksValue: () => true,
    specsValue: () => [],
  }
}

console.log('=== 1. 早期订阅在 install 后才能被注销（被修掉的那条泄漏）===')
{
  const grouping = await freshGrouping()
  const model = fakeModel()
  let notified = 0
  const cancel = grouping.clientGrouping.subscribe(() => { notified += 1 })

  check('attach 前：还没挂在 live 上', model.grouping.listenerCount() === 0,
    String(model.grouping.listenerCount()))

  grouping.installProjectModel(model)
  check('install 后：挂到了 live 上', model.grouping.listenerCount() === 1,
    String(model.grouping.listenerCount()))
  check('install 会通知一次（快照身份变了）', notified === 1, String(notified))

  cancel()
  check('注销后：live 上不再有监听器 ← 这就是被修掉的泄漏',
    model.grouping.listenerCount() === 0, String(model.grouping.listenerCount()))

  model.grouping.emit(['g2'])
  check('注销后：再通知也不会回调', notified === 1, String(notified))
}

console.log('')
console.log('=== 2. 迟到的订阅（模型已在）直接挂 live，且可注销 ===')
{
  const grouping = await freshGrouping()
  const model = fakeModel()
  grouping.installProjectModel(model)
  let notified = 0
  const cancel = grouping.clientGrouping.subscribe(() => { notified += 1 })
  check('直接挂在 live 上', model.grouping.listenerCount() === 1, String(model.grouping.listenerCount()))
  model.grouping.emit(['x'])
  check('收到通知', notified === 1, String(notified))
  cancel()
  check('注销后脱离 live', model.grouping.listenerCount() === 0, String(model.grouping.listenerCount()))
}

console.log('')
console.log('=== 3. install 前注销：不会被 install 复活 ===')
{
  // The mirror case: a subscriber that unsubscribes *before* the model lands must not be
  // attached by the install pass at all. The old install passed a cleared snapshot to
  // `subscribe` without consulting any disposer, so this is worth pinning.
  const grouping = await freshGrouping()
  const model = fakeModel()
  grouping.clientGrouping.subscribe(() => {})()
  grouping.installProjectModel(model)
  check('提前注销的监听器不会被 install 挂上', model.grouping.listenerCount() === 0,
    String(model.grouping.listenerCount()))
}

console.log('')
console.log('=== 4. 每个 seat 都遵循同一契约 ===')
{
  // The defect was in all of them, so all of them are checked rather than a
  // representative one: the shared helper is only a real fix if every seat uses it.
  const seats = [
    ['clientGrouping', 'clientGrouping', 'grouping'],
    ['clientExpansions', 'clientExpansions', 'expansions'],
    ['clientOrders', 'clientOrders', 'orders'],
    ['clientNewSessionTarget', 'clientNewSessionTarget', 'newSessionTarget$'],
    ['clientBaseWorkspace', 'clientBaseWorkspace', 'baseWorkspace$'],
    ['clientCreateOpensSession', 'clientCreateOpensSession', 'createOpensSession$'],
    ['clientInjectProjectInfo', 'clientInjectProjectInfo', 'injectProjectInfo$'],
    ['clientInjectProjectDoc', 'clientInjectProjectDoc', 'injectProjectDoc$'],
    ['clientDocSpecMode', 'clientDocSpecMode', 'docSpecMode$'],
    ['clientDocSpecFileName', 'clientDocSpecFileName', 'docSpecFileName$'],
    ['clientPerProjectDocSpec', 'clientPerProjectDocSpec', 'perProjectDocSpec$'],
    ['clientValidateLinks', 'clientValidateLinks', 'validateLinks$'],
    ['clientSpecs', 'clientSpecs', 'specs$'],
  ]
  for (const [name, exportName, seatName] of seats) {
    const grouping = await freshGrouping()
    const model = fakeModel()
    const live = model[seatName]
    const cancel = grouping[exportName].subscribe(() => {})
    grouping.installProjectModel(model)
    const attached = live.listenerCount()
    cancel()
    check(`${name}: install 后挂上、注销后脱离`,
      attached === 1 && live.listenerCount() === 0,
      `attached=${String(attached)} after=${String(live.listenerCount())}`)
  }
}

console.log('')
console.log('=== 5. 每个 seat 的 pre-model 快照不变 ===')
{
  // The fallbacks are what a fresh install shows, and the rewrite had to preserve them
  // exactly. Asserted so a future edit cannot quietly change the card's first paint.
  const grouping = await freshGrouping()
  check('grouping 是空数组（不是 undefined）',
    Array.isArray(grouping.clientGrouping.getSnapshot()) && grouping.clientGrouping.getSnapshot().length === 0,
    JSON.stringify(grouping.clientGrouping.getSnapshot()))
  check('newSessionTarget = ungrouped', grouping.clientNewSessionTarget.getSnapshot() === 'ungrouped',
    String(grouping.clientNewSessionTarget.getSnapshot()))
  check('baseWorkspace = default 模式', grouping.clientBaseWorkspace.getSnapshot().mode === 'default',
    JSON.stringify(grouping.clientBaseWorkspace.getSnapshot()))
  check('createOpensSession = true', grouping.clientCreateOpensSession.getSnapshot() === true,
    String(grouping.clientCreateOpensSession.getSnapshot()))
  check('injectProjectInfo = true', grouping.clientInjectProjectInfo.getSnapshot() === true,
    String(grouping.clientInjectProjectInfo.getSnapshot()))
  check('injectProjectDoc = false', grouping.clientInjectProjectDoc.getSnapshot() === false,
    String(grouping.clientInjectProjectDoc.getSnapshot()))
  check('docSpecMode = default', grouping.clientDocSpecMode.getSnapshot() === 'default',
    String(grouping.clientDocSpecMode.getSnapshot()))
  check('docSpecFileName = 空串', grouping.clientDocSpecFileName.getSnapshot() === '',
    JSON.stringify(grouping.clientDocSpecFileName.getSnapshot()))
  check('perProjectDocSpec = false', grouping.clientPerProjectDocSpec.getSnapshot() === false,
    String(grouping.clientPerProjectDocSpec.getSnapshot()))
  check('validateLinks = true', grouping.clientValidateLinks.getSnapshot() === true,
    String(grouping.clientValidateLinks.getSnapshot()))
  check('specs = 空数组', Array.isArray(grouping.clientSpecs.getSnapshot()) && grouping.clientSpecs.getSnapshot().length === 0,
    JSON.stringify(grouping.clientSpecs.getSnapshot()))
  check('locale = zh（服务未到）', grouping.clientInjectionLocale.getSnapshot() === 'zh',
    String(grouping.clientInjectionLocale.getSnapshot()))
}

console.log('')
console.log('=== 6. 模型到达后快照改由模型回答 ===')
{
  const grouping = await freshGrouping()
  const model = fakeModel()
  model.grouping.emit(['from-model'])
  const before = grouping.clientGrouping.getSnapshot()
  grouping.installProjectModel(model)
  const after = grouping.clientGrouping.getSnapshot()
  check('install 前是空数组', Array.isArray(before) && before.length === 0, JSON.stringify(before))
  check('install 后读模型的值', JSON.stringify(after) === JSON.stringify(['from-model']), JSON.stringify(after))
}

console.log('')
console.log('=== 7. locale seat 也会重新安置早期订阅（同一缺陷的另一半）===')
{
  // This seat never re-seated at all before the fix, so a card that subscribed before
  // `apply` was registered nowhere and sat on the 'zh' fallback forever even once the
  // Host had resolved 'en'.
  const grouping = await freshGrouping()
  const listeners = new Set()
  const service = {
    getSnapshot: () => ({ active: 'en-US' }),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  let notified = 0
  const cancel = grouping.clientInjectionLocale.subscribe(() => { notified += 1 })
  check('服务到达前：不在任何地方注册', listeners.size === 0, String(listeners.size))
  check('服务到达前：快照是 zh', grouping.clientInjectionLocale.getSnapshot() === 'zh',
    grouping.clientInjectionLocale.getSnapshot())

  grouping.installLocaleService(service)
  check('服务到达后：被登记', listeners.size === 1, String(listeners.size))
  check('服务到达后：读到 en', grouping.clientInjectionLocale.getSnapshot() === 'en',
    grouping.clientInjectionLocale.getSnapshot())

  cancel()
  check('注销后：脱离服务 ← 这就是被修掉的泄漏', listeners.size === 0, String(listeners.size))
  // `notified` may be 1 from the re-seat notification; the point is that it does not keep
  // climbing after disposal.
  const at = notified
  for (const listener of [...listeners]) listener()
  check('注销后：不再回调', notified === at, String(notified))
}

console.log('')
console.log('=== 8. 服务缺席时 early 订阅者不被永久搁置 ===')
{
  const grouping = await freshGrouping()
  let notified = 0
  grouping.clientInjectionLocale.subscribe(() => { notified += 1 })
  grouping.installLocaleService(undefined)
  check('服务为 undefined 时仍会通知一次（不再搁置）', notified === 1, String(notified))
  check('并回落到 zh', grouping.clientInjectionLocale.getSnapshot() === 'zh',
    grouping.clientInjectionLocale.getSnapshot())
}

console.log('')
if (failures.length === 0) {
  console.log('ALL CHECKS PASSED')
} else {
  console.log(`${failures.length} CHECK(S) FAILED:`)
  for (const failure of failures) console.log(`  ${failure}`)
  process.exitCode = 1
}
