/**
 * When is a service provided by THIS fiber readable from THIS fiber?
 *
 * The vendored browser would read `projectGrouping` lazily (inside the slot
 * inject factory, which runs after apply). Two shapes are under test:
 *   A. read synchronously inside apply, right after provide  -> (seen: undefined)
 *   B. read later, after the fiber is ready, from the same ctx
 *   C. read from a nested child fiber
 *   D. read by a DIFFERENT plugin's fiber
 */
import { Context } from '@deepseek-ai/cordis'

const observable = { marker: 'grouping' }
const root = new Context()
const seen = {}

root.plugin({
  name: 'our-entry',
  apply(ctx) {
    ctx.provide('projectGrouping', observable)
    seen.A_immediately = ctx.get('projectGrouping')

    // B: after the current apply unwinds (fiber ready), read again.
    setTimeout(() => { seen.B_afterApply = ctx.get('projectGrouping') }, 30)

    // C: nested child fiber.
    ctx.plugin({
      name: 'child',
      apply(childCtx) {
        seen.C_childSync = childCtx.get('projectGrouping')
        setTimeout(() => { seen.C_childLater = childCtx.get('projectGrouping') }, 40)
      },
    })
  },
})

// D: a separate sibling plugin.
root.plugin({
  name: 'sibling',
  apply(ctx) {
    seen.D_siblingSync = ctx.get('projectGrouping')
    setTimeout(() => { seen.D_siblingLater = ctx.get('projectGrouping') }, 50)
  },
})

await new Promise(r => setTimeout(r, 120))
for (const [k, v] of Object.entries(seen)) {
  console.log(`${k.padEnd(18)} = ${v === observable ? 'observable ✓' : String(v)}`)
}
console.log('root.get          =', root.get('projectGrouping') === observable ? 'observable ✓' : root.get('projectGrouping'))
