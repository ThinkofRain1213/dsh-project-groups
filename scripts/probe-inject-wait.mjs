/**
 * How does a plugin wait for a Remote namespace it mounts itself?
 *
 * The failure was `cannot get property "remote.projectGroups" without inject`:
 * cordis gates property access on the fiber's declared dependencies. The
 * namespace service is created by our own `$mount`, so declaring
 * `remote.projectGroups` in `inject` would make the fiber wait on something only
 * it can create — a deadlock.
 *
 * Three access shapes are under test, each on a real Context with a service that
 * mounts another service the way the Gateway does (`ownerCtx.plugin(...)`):
 *
 *   A. bare property access without inject      -> expected to throw (the bug)
 *   B. `ctx.get('remote.demo')` without inject  -> does the explicit lookup bypass the gate?
 *   C. `ctx.inject(['remote.demo'], cb)`        -> does parking resolve once mount lands?
 *   D. the same `inject` shape for an already-present service
 *
 * C is the shape worth having if it works: it is cordis's own "wait for a
 * service" primitive, and it does not depend on `$mount` having resolved first.
 *
 * ## Why `tick()`-style sleeps are gone
 *
 * The scenarios used to advance on a fixed `setTimeout(..., 30)`. That is a race,
 * not a synchronisation: on a loaded machine the callback under test may not have
 * run yet, so an assertion could be evaluated too early and report a false PASS or
 * FAIL. Readiness is now awaited explicitly — `root.plugin(...)` returns the fiber,
 * a thenable that settles once the fiber is ready — and the "did the service
 * land?" question is answered by polling `ctx.get` with a bounded deadline and a
 * clear terminal message instead of sleeping and hoping.
 */
import { Context, Service } from '@deepseek-ai/cordis'

/** How long to wait for a service to appear, and how often to look. */
const READY_POLL_TIMEOUT_MS = 2000
const READY_POLL_INTERVAL_MS = 5

/** The message cordis raises for the gate this whole probe is about. */
const WITHOUT_INJECT = 'without inject'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * Wait until `ctx.get(key)` reports the service.
 *
 * Returns normally once it is visible and throws a descriptive error when the
 * deadline passes, so a genuine "it never landed" is loud instead of reading as a
 * downstream `undefined`.
 * @param ctx - the context to read from.
 * @param key - the service key, e.g. `remote.demo`.
 * @returns a promise that settles once the service is visible.
 */
async function waitForService(ctx, key) {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (ctx.get(key) !== undefined) return
    await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS))
  }
  throw new Error(`${key} did not become visible within ${READY_POLL_TIMEOUT_MS}ms`)
}

/** Stands in for the Gateway: owns `$mount`, which spins up a namespace service. */
class FakeGateway extends Service {
  constructor(ctx) {
    super(ctx, 'remote')
  }

  async $mount(name) {
    const fiber = this.ctx.plugin({
      name: `remote.${name}`,
      apply: (ctx) => { new Service(ctx, `remote.${name}`) },
    })
    await fiber
  }
}

/**
 * A Context with a mounted `remote.demo`, ready to hand to a consumer plugin.
 *
 * Extracted because scenarios A, B and D all built this by hand: three copies of
 * the same bootstrap meant a change to the setup had to be made in three places,
 * and one missed copy would have silently changed what a scenario measured.
 * @returns a promise for the root Context, with the service already visible.
 */
async function setupMounted() {
  const root = new Context()
  new FakeGateway(root)
  await root.remote.$mount('demo')
  await waitForService(root, 'remote.demo')
  return root
}

/** Run a plugin to readiness so the assertions that follow are not racing it. */
async function runPlugin(root, plugin) {
  const fiber = root.plugin(plugin)
  await fiber
}

// --- A: bare property access, no inject --------------------------------------
{
  const root = await setupMounted()

  // Positive control first. If `ctx.remote` itself were missing (or the bootstrap
  // were broken) any error below would still look like the expected one, and the
  // scenario would pass for the wrong reason — which is exactly what this block
  // is guarding against.
  check('A: the gateway namespace itself is reachable',
    root.remote !== undefined && root.remote.name === 'remote',
    String(root.remote?.name))

  let thrown = null
  let succeeded = false
  await runPlugin(root, {
    name: 'consumer-a',
    apply(ctx) {
      try {
        void ctx.remote.demo
        succeeded = true
      } catch (error) {
        thrown = error
      }
    },
  })

  // Assert the specific error, not "anything was thrown": an unrelated TypeError
  // from the setup would otherwise satisfy this check while proving nothing.
  check('A: bare access without inject throws the cordis gate error',
    thrown !== null && String(thrown.message).includes(WITHOUT_INJECT),
    thrown === null ? (succeeded ? 'it succeeded — the gate is gone' : 'nothing threw and nothing resolved') : String(thrown.message))
}

// --- B: ctx.get, no inject ---------------------------------------------------
{
  const root = await setupMounted()

  let viaGet
  let error = null
  await runPlugin(root, {
    name: 'consumer-b',
    apply(ctx) {
      // `ctx.get` is the explicit lookup, so it is not the property gate under
      // test in A; a throw here would be its own finding and must be reported
      // rather than crashing the run.
      try { viaGet = ctx.get('remote.demo') } catch (caught) { error = caught }
    },
  })

  check('B: ctx.get without inject resolves the service',
    error === null && viaGet !== undefined,
    error === null ? (viaGet === undefined ? 'undefined' : 'resolved') : `THREW: ${error.message}`)
}

// --- C: ctx.inject parks until the service appears ---------------------------
{
  const root = new Context()
  new FakeGateway(root)

  const injected = { fired: false, value: undefined, thrown: null, error: null }
  await runPlugin(root, {
    name: 'consumer-c',
    apply(ctx) {
      // The thrown case is recorded as its own field. Encoding it as a
      // `'THREW: ...'` string in the same variable and then prefix-matching it
      // made the two outcomes share one slot, where a service whose value happened
      // to start with that word would be indistinguishable from a failure.
      ctx.inject(['remote.demo'], (injectedCtx) => {
        injected.fired = true
        try { injected.value = injectedCtx.remote.demo } catch (error) { injected.thrown = error }
      })
    },
  })
  check('C: inject has not fired while the service is absent', injected.fired === false)

  // Guarded: an unguarded `$mount` rejection is a top-level unhandled rejection,
  // which would kill the probe before the summary and the exit code below.
  let mountError = null
  try {
    await root.remote.$mount('demo')
    await waitForService(root, 'remote.demo')
  } catch (error) {
    mountError = error
  }
  check('C: $mount landed the service', mountError === null, mountError === null ? undefined : mountError.message)

  check('C: inject fires once $mount lands the service', injected.fired === true)
  check('C: and the callback may read it as a property',
    injected.thrown === null && injected.value !== undefined,
    injected.thrown === null
      ? (injected.value === undefined ? 'undefined' : 'resolved')
      : `THREW: ${injected.thrown.message}`)
}

// --- D: inject resolves even when the service already exists ------------------
{
  const root = await setupMounted()

  let fired = false
  await runPlugin(root, {
    name: 'consumer-d',
    apply(ctx) { ctx.inject(['remote.demo'], () => { fired = true }) },
  })
  check('D: inject fires for an already-present service', fired === true)
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
