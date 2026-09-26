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
 *
 * C is the shape worth having if it works: it is cordis's own "wait for a
 * service" primitive, and it does not depend on `$mount` having resolved first.
 */
import { Context, Service } from '@deepseek-ai/cordis'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30))

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

// --- A: bare property access, no inject --------------------------------------
{
  const root = new Context()
  new FakeGateway(root)
  await root.remote.$mount('demo')
  await tick()

  const consumer = {
    name: 'consumer-a',
    apply(ctx) {
      try {
        void ctx.remote.demo
        check('A: bare access without inject throws', false, 'it succeeded')
      } catch (error) {
        check('A: bare access without inject throws', true, String(error.message).slice(0, 60))
      }
    },
  }
  root.plugin(consumer)
  await tick()
}

// --- B: ctx.get, no inject ---------------------------------------------------
{
  const root = new Context()
  new FakeGateway(root)
  await root.remote.$mount('demo')
  await tick()

  const consumer = {
    name: 'consumer-b',
    apply(ctx) {
      const viaGet = ctx.get('remote.demo')
      check('B: ctx.get without inject resolves the service', viaGet !== undefined,
        viaGet === undefined ? 'undefined' : 'resolved')
    },
  }
  root.plugin(consumer)
  await tick()
}

// --- C: ctx.inject parks until the service appears ---------------------------
{
  const root = new Context()
  new FakeGateway(root)
  let fired = false
  let viaProperty
  const consumer = {
    name: 'consumer-c',
    apply(ctx) {
      ctx.inject(['remote.demo'], (injected) => {
        fired = true
        try { viaProperty = injected.remote.demo } catch (error) { viaProperty = `THREW: ${error.message}` }
      })
    },
  }
  root.plugin(consumer)
  await tick()
  check('C: inject has not fired while the service is absent', fired === false)

  await root.remote.$mount('demo')
  await tick()
  check('C: inject fires once $mount lands the service', fired === true)
  check('C: and the callback may read it as a property',
    viaProperty !== undefined && !String(viaProperty).startsWith('THREW'),
    typeof viaProperty === 'object' ? 'resolved' : String(viaProperty))
}

// --- D: inject resolves even when the service already exists ------------------
{
  const root = new Context()
  new FakeGateway(root)
  await root.remote.$mount('demo')
  await tick()

  let fired = false
  root.plugin({
    name: 'consumer-d',
    apply(ctx) { ctx.inject(['remote.demo'], () => { fired = true }) },
  })
  await tick()
  check('D: inject fires for an already-present service', fired === true)
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
