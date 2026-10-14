/**
 * Approach B2, tested the way the real composition works: two SEPARATE plugin
 * fibers, not two calls on one context.
 *
 * The cordis contract for `ctx.set` is "only the fiber that provided the
 * service may set it". A single-context test passes trivially (the root
 * provided it), so the meaningful question is whether a second plugin — our
 * plugin, loaded as its own fiber — can take over the `workspaces` service
 * that the official workspace-controller provided.
 *
 * The expected refusals are matched against cordis' own wording, and anything else is
 * reported as a failure rather than as a refusal: the previous shape formatted every caught
 * error into a `refused: …` string and then asserted that the string started with
 * `refused`, which is true of *any* throw — including a TypeError caused by a bug in this
 * probe. See {@link classify}.
 */
import { Context } from '@deepseek-ai/cordis'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

const officialValue = { marker: 'official' }
const impostorValue = { marker: 'impostor' }

const root = new Context()

/**
 * Load one plugin fiber and wait for it to finish applying.
 *
 * `ctx.plugin()` only **schedules** the fiber; cordis' own docblock says the returned handle
 * "settles once loading finished", so awaiting it is the deterministic wait for that. The
 * previous answer was a fixed 20 ms sleep — a guess that, under load, let the checks below
 * read state from a fiber that had not run yet (a false FAIL, or a false PASS when the
 * timing happened to hide the violation). A throw here is reported rather than left to abort
 * the script with no diagnostics.
 * @param label - which fiber, for the failure message.
 * @param plugin - the plugin object to load.
 */
const loadPlugin = async (label, plugin) => {
  try {
    await root.plugin(plugin)
  } catch (error) {
    check(`${label}: fiber 无错误地完成 apply`, false, String(error?.stack ?? error))
  }
}

/**
 * Run one override attempt and record what happened.
 *
 * Recorded as data rather than as a pre-formatted `refused: …` string so the assertions can
 * tell cordis' documented refusal from an unrelated error — see {@link classify}.
 * @param run - the attempt.
 * @returns the outcome, plus the message when it threw.
 */
const attempt = (run) => {
  try {
    run()
    return { outcome: 'succeeded' }
  } catch (error) {
    return { outcome: 'threw', message: String(error?.message ?? error) }
  }
}

/**
 * Judge one recorded attempt against the refusal cordis documents for that route.
 *
 * `recognised` is what makes the check meaningful: a `TypeError` from a bug in this probe
 * also has an `outcome` of `threw`, but it does not match the documented conflict, so it is
 * reported as a failure with its own message instead of being counted as the refusal under
 * test. `undefined` is its own outcome too — it means the fiber never ran, which the caller
 * asserts before this is consulted.
 * @param recorded - the value {@link attempt} left on the results object.
 * @param refusal - the exact cordis wording for this route's refusal.
 * @returns the verdict plus the detail string for the log.
 */
const classify = (recorded, refusal) => {
  if (recorded === undefined) {
    return { refused: false, recognised: false, detail: '未记录：apply 没有运行' }
  }
  if (recorded.outcome === 'succeeded') return { refused: false, recognised: false, detail: 'succeeded' }
  return {
    refused: true,
    recognised: refusal.test(recorded.message),
    detail: recorded.message,
  }
}

// Plugin 1: the official peer that provides `workspaces`.
const officialPlugin = {
  name: 'official-workspace-client',
  apply(ctx) {
    ctx.provide('workspaces', officialValue)
  },
}
await loadPlugin('official plugin', officialPlugin)
check('official plugin provided the service',
  root.get('workspaces') === officialValue,
  `resolved marker=${root.get('workspaces')?.marker}`)

// Plugin 2: our plugin, its own fiber, trying the two override routes.
const results = {}
const ourPlugin = {
  name: 'project-groups',
  apply(ctx) {
    results.provide = attempt(() => ctx.provide('workspaces', impostorValue))
    results.set = attempt(() => ctx.set('workspaces', impostorValue))
  },
}
await loadPlugin('our plugin', ourPlugin)

// "Never recorded" gets its own check, first: without it the two checks below evaluated
// `undefined` → falsy and reported a refusal that was never actually observed, which is
// misleading for a probe whose whole purpose is to classify refusal vs. acceptance.
check('our plugin fiber ran both override attempts',
  results.provide !== undefined && results.set !== undefined,
  JSON.stringify(results))

const provide = classify(results.provide, /^service "workspaces" has been registered at </)
const set = classify(results.set, /^cannot set property "workspaces" in multiple fibers$/)
check('B2 via provide: second fiber is refused（且是 cordis 的登记冲突，不是别的异常）',
  provide.refused && provide.recognised, provide.detail)
check('B2 via set: second fiber is refused（且是 cordis 的多 fiber 冲突，不是别的异常）',
  set.refused && set.recognised, set.detail)
check('service still resolves to the official value',
  root.get('workspaces') === officialValue,
  `resolved marker=${root.get('workspaces')?.marker}`)

const summary = failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`
console.log(`\n${summary}`)
// `process.exitCode` rather than `process.exit()`: with stdout on a pipe (CI log capture)
// `console.log` is asynchronous, and an immediate exit truncated exactly the FAIL lines the
// run exists to print.
process.exitCode = failures.length === 0 ? 0 : 1
