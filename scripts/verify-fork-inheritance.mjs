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
  const undo = wrapFork(sessions, deps('P1', record))
  undo()
  await sessions.fork({ sessionId: 'parent' })
  check('还原后不再写入', record.assigns.length === 0, JSON.stringify(record.assigns))
  check('还原后 fork 回到原型方法', sessions.fork.marker !== true,
    String(sessions.fork.marker))
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

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
