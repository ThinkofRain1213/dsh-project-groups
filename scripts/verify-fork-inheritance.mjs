/**
 * Assert the fork-inheritance wrapper's properties, against the shipped code.
 *
 * ## Why every case here is a property, not an example
 *
 * The wrapper shadows `ClientSessions.fork` on the live instance, so the ways it
 * can be wrong are not "did it assign the right project" but the ways a
 * shadowing wrapper breaks silently:
 *
 *  - `this` lost, which destroys **every** fork rather than only this feature;
 *  - the caller's `onCreated` swallowed, which drops the sidebar's analytics
 *    while the fork still succeeds;
 *  - a write on the failure path, which leaves an assignment pointing at a
 *    Session the user was told never got created;
 *  - a second wrap after a hot reload, which writes the same assignment twice.
 *
 * Each of those is a `check` below, driven by a fake whose `fork` reads `this`
 * the way the real one does.
 *
 * Usage: node scripts/verify-fork-inheritance.mjs
 */
import { register } from 'node:module'
register('./lib/ts-loader.mjs', import.meta.url)

const { wrapFork } = await import('../src/client/fork-inheritance.ts')

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * A stand-in for `ClientSessions` carrying only what the wrapper can touch.
 *
 * `fork` reads `this.marker`, exactly like the real one reads `this.list` and
 * `this.manager`: a wrapper that calls the captured function instead of
 * `original.call(sessions, …)` gets `undefined` here and the marker assertion
 * catches it, where a fake with no `this` use would pass either way.
 *
 * `afterOnCreated` reproduces the real ordering (`service.ts:474-482`):
 * `onCreated` fires **before** the child-title rename, and the rename can throw.
 * That is what makes "write after the promise resolves" different from "write
 * inside onCreated".
 */
const fakeSessions = ({ outcome = 'ok', afterOnCreated = 'ok' } = {}) => {
  const record = { forks: [], assigns: [], warns: [], created: [] }
  const sessions = {
    marker: 'original',
    async fork(opts) {
      // Proves this bound to the instance rather than to nothing.
      if (this?.marker !== 'original') throw new TypeError('fork: lost `this`')
      record.forks.push(opts.sessionId)
      if (outcome === 'throw') throw new Error('fork failed')
      opts.onCreated?.(`child-${record.forks.length}`)
      record.created.push(`child-${record.forks.length}`)
      // The rename that follows onCreated in the real implementation.
      if (afterOnCreated === 'throw') throw new Error('fork child rename failed')
      return `child-${record.forks.length}`
    },
  }
  // The method as the instance shipped it, so a test can tell "still wrapped"
  // from "restored" by identity rather than by a marker that never existed.
  record.originalFork = sessions.fork
  return { sessions, record }
}
const deps = (projectId, record, { assignThrows = false } = {}) => ({
  projectOf: () => projectId,
  assign: async (childId, pid) => {
    if (assignThrows) throw new Error('assign failed')
    record.assigns.push([childId, pid])
  },
  warn: (message) => { record.warns.push(message) },
})

// --- 1. A filed parent hands its project to the child -----------------------
{
  const { sessions, record } = fakeSessions()
  const undo = wrapFork(sessions, deps('P1', record))
  await sessions.fork({ sessionId: 'parent' })
  undo()
  check('父有项目 → 子会话收到父项目',
    JSON.stringify(record.assigns) === JSON.stringify([['child-1', 'P1']]),
    JSON.stringify(record.assigns))
}

// --- 2. An unfiled parent writes nothing, and is not an error ----------------
{
  const { sessions, record } = fakeSessions()
  const undo = wrapFork(sessions, deps(undefined, record))
  const childId = await sessions.fork({ sessionId: 'parent' })
  undo()
  check('父无项目 → 不写入', record.assigns.length === 0, JSON.stringify(record.assigns))
  check('父无项目 → fork 仍返回值', childId === 'child-1', String(childId))
  check('父无项目 → 不记警告', record.warns.length === 0, JSON.stringify(record.warns))
}

// --- 3. A refused assignment does not fail the fork -------------------------
{
  const { sessions, record } = fakeSessions()
  const undo = wrapFork(sessions, deps('P1', record, { assignThrows: true }))
  let threw = false
  let childId
  try { childId = await sessions.fork({ sessionId: 'parent' }) } catch { threw = true }
  undo()
  check('assign 拒绝 → fork 不抛', threw === false, String(threw))
  check('assign 拒绝 → fork 仍返回子会话', childId === 'child-1', String(childId))
  // The rejection is asynchronous relative to the fork promise; give it a beat.
  await new Promise(resolve => setTimeout(resolve, 20))
  check('assign 拒绝 → 记了警告', record.warns.length === 1, JSON.stringify(record.warns))
}

// --- 4. A defeated fork propagates and writes nothing -----------------------
{
  const { sessions, record } = fakeSessions({ outcome: 'throw' })
  const undo = wrapFork(sessions, deps('P1', record))
  let message = ''
  try { await sessions.fork({ sessionId: 'parent' }) } catch (error) { message = error.message }
  undo()
  check('fork 抛错 → 异常原样透传', message === 'fork failed', message)
  check('fork 抛错 → 不写入', record.assigns.length === 0, JSON.stringify(record.assigns))
}

// --- 5. The caller's own onCreated still runs, exactly once -----------------
{
  const { sessions, record } = fakeSessions()
  let calls = 0
  const undo = wrapFork(sessions, deps('P1', record))
  await sessions.fork({ sessionId: 'parent', onCreated: () => { calls += 1 } })
  undo()
  check('调用方的 onCreated 被调用恰好一次', calls === 1, String(calls))
}

// --- 6. `this` is bound to the original instance ----------------------------
{
  const { sessions, record } = fakeSessions()
  const undo = wrapFork(sessions, deps('P1', record))
  // The fake throws from inside fork when `this` is lost, so reaching here with
  // no throw and one recorded fork is the evidence.
  let lost = false
  try { await sessions.fork({ sessionId: 'parent' }) } catch (error) {
    lost = String(error).includes('lost `this`')
  }
  undo()
  check('包装后 this 仍绑定原实例', lost === false && record.forks.length === 1,
    JSON.stringify({ lost, forks: record.forks }))
}

// --- 7. A second wrap does not write twice ----------------------------------
{
  const { sessions, record } = fakeSessions()
  const undoFirst = wrapFork(sessions, deps('P1', record))
  const undoSecond = wrapFork(sessions, deps('P1', record))
  await sessions.fork({ sessionId: 'parent' })
  undoSecond()
  undoFirst()
  check('重复包装只写一次', record.assigns.length === 1, JSON.stringify(record.assigns))
}

// --- 8. The cleanup restores the original method ----------------------------
{
  const { sessions, record } = fakeSessions()
  // Capture the method object itself: the assertion below compares identity, so
  // it can only pass when the very same function is back on the instance.
  // The previous version checked `sessions.fork.marker !== true`, but `marker`
  // lives on `sessions`, never on `fork`, so it was `undefined` in every state —
  // including while still wrapped. It passed without testing anything.
  const original = sessions.fork
  const undo = wrapFork(sessions, deps('P1', record))
  const wrapped = sessions.fork
  check('包装后实例上换成了另一个函数', wrapped !== original, String(wrapped === original))
  undo()
  check('还原后 fork 是原来那个函数', sessions.fork === original, String(sessions.fork === wrapped))
  await sessions.fork({ sessionId: 'parent' })
  check('还原后不再写入', record.assigns.length === 0, JSON.stringify(record.assigns))
}

// --- 9. A failure AFTER onCreated must not write ----------------------------
{
  // The real `ClientSessions.fork` calls onCreated, then renames the child, and
  // a failed rename rejects the whole call. Writing inside onCreated would leave
  // an assignment for a fork the caller was told failed.
  const { sessions, record } = fakeSessions({ afterOnCreated: 'throw' })
  const undo = wrapFork(sessions, deps('P1', record))
  let threw = false
  try { await sessions.fork({ sessionId: 'parent' }) } catch { threw = true }
  undo()
  check('onCreated 之后才失败 → 异常透传', threw === true, String(threw))
  check('onCreated 之后才失败 → 不写入', record.assigns.length === 0,
    JSON.stringify(record.assigns))
}

// --- 10. A model that has not landed yet is not an error --------------------
{
  // `projectModel()` answers undefined until the Remote baseline arrives, and
  // the plugin is installed before that. A branch taken in that window must not
  // warn or throw — there is simply nothing to inherit from yet.
  const { sessions, record } = fakeSessions()
  const undo = wrapFork(sessions, {
    // Exactly what `projectModel()?.projectOf(id)` answers with no model.
    projectOf: () => undefined,
    assign: async () => Promise.reject(new Error('must not be called')),
    warn: (message) => { record.warns.push(message) },
  })
  let threw = false
  let childId
  try { childId = await sessions.fork({ sessionId: 'parent' }) } catch { threw = true }
  undo()
  check('模型未就绪 → 不抛', threw === false, String(threw))
  check('模型未就绪 → fork 仍返回子会话', childId === 'child-1', String(childId))
  check('模型未就绪 → 不写 assignment、不记警告',
    record.assigns.length === 0 && record.warns.length === 0, JSON.stringify(record))
}

// --- 11. A stale disposer must not tear down a newer wrap -------------------
{
  // The HMR shape this guards against: two *different* wrappers in sequence,
  // where the older disposer runs after the newer one installed.
  //
  // `wrapFork` refuses to stack when it sees its own marker, so the sequence has
  // to be built the way Cordis actually produces it: the first wrapper, then a
  // *second, independent* wrapper (as a reloaded module copy would install), then
  // the first disposer. Without an ownership check that disposer restores the
  // original and the live instance ends up unwrapped.
  //
  // `index.ts:401-407` already guards this race for the module-level service
  // captures; this wrapper owes the same discipline.
  const { sessions, record } = fakeSessions()
  const originalFork = sessions.fork
  const undoFirst = wrapFork(sessions, deps('P1', record))
  const firstWrapped = sessions.fork
  // Clear the marker so a second, independent wrap installs over the first —
  // exactly what a reloaded module copy does (its `Symbol.for` marker is the same,
  // but the *wrapper identity* differs, which is what the ownership check reads).
  delete firstWrapped[Symbol.for('dsh-project-groups/fork-inheritance')]
  const undoSecond = wrapFork(sessions, deps('P1', record))
  check('第二次包装确实换成了另一个函数', sessions.fork !== firstWrapped,
    String(sessions.fork === firstWrapped))
  // The first fibre's disposer runs after the second installed.
  undoFirst()
  check('旧 disposer 不会把新包装拆掉', sessions.fork !== originalFork,
    String(sessions.fork === originalFork))
  await sessions.fork({ sessionId: 'parent' })
  check('旧 disposer 跑过之后继承仍然生效', record.assigns.length >= 1,
    JSON.stringify(record.assigns))
  undoSecond()
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
