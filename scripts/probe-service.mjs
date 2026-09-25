/**
 * Approach B2, tested the way the real composition works: two SEPARATE plugin
 * fibers, not two calls on one context.
 *
 * The cordis contract for `ctx.set` is "only the fiber that provided the
 * service may set it". A single-context test passes trivially (the root
 * provided it), so the meaningful question is whether a second plugin — our
 * plugin, loaded as its own fiber — can take over the `workspaces` service
 * that the official workspace-controller provided.
 */
import { Context } from '@deepseek-ai/cordis'

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const officialValue = { marker: 'official' }
const impostorValue = { marker: 'impostor' }

const root = new Context()

// Plugin 1: the official peer that provides `workspaces`.
const officialPlugin = {
  name: 'official-workspace-client',
  apply(ctx) {
    ctx.provide('workspaces', officialValue)
  },
}
root.plugin(officialPlugin)
// `ctx.plugin()` schedules the fiber; wait for its apply to settle.
await new Promise(resolve => setTimeout(resolve, 20))
check('official plugin provided the service',
  root.get('workspaces') === officialValue,
  `resolved marker=${root.get('workspaces')?.marker}`)

// Plugin 2: our plugin, its own fiber, trying the two override routes.
const results = {}
const ourPlugin = {
  name: 'project-groups',
  apply(ctx) {
    try {
      ctx.provide('workspaces', impostorValue)
      results.provide = 'succeeded'
    } catch (error) {
      results.provide = `refused: ${error.message.slice(0, 70)}`
    }
    try {
      ctx.set('workspaces', impostorValue)
      results.set = 'succeeded'
    } catch (error) {
      results.set = `refused: ${error.message.slice(0, 70)}`
    }
  },
}
root.plugin(ourPlugin)
await new Promise(resolve => setTimeout(resolve, 20))

check('B2 via provide: second fiber is refused', results.provide?.startsWith('refused'), results.provide)
check('B2 via set: second fiber is refused', results.set?.startsWith('refused'), results.set)
check('service still resolves to the official value',
  root.get('workspaces') === officialValue,
  `resolved marker=${root.get('workspaces')?.marker}`)

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`)
process.exit(failures.length === 0 ? 0 : 1)
