// Add the missing `child.on('error')` handler to every probe that awaits a boot-timeout promise.
//
// A failed `spawn` (bad exe path, permission denied) emits `'error'` — which crashes the process
// when unhandled — and never writes to stdout, so the boot promise stayed pending until the 120 s
// timeout and reported 'boot timeout' for what was really a bad path. Measured before this:
// 3 of 59 probes had a handler; all three were ones fixed earlier in this phase.
import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'

const ANCHOR = 'const timer = setTimeout(() => reject(new Error('
const files = readdirSync('scripts').filter(f => f.startsWith('probe-') && f.endsWith('.mjs'))

let changed = 0
let skippedMulti = []
let skippedHas = []
let skippedNo = []

for (const f of files) {
  const p = `scripts/${f}`
  const s = readFileSync(p, 'utf8')
  const lines = s.split('\n')
  const hits = lines.map((l, i) => (l.includes(ANCHOR) ? i : -1)).filter(i => i >= 0)

  if (hits.length === 0) { skippedNo.push(f); continue }
  if (hits.length > 1) { skippedMulti.push(f); continue }
  if (/child\.on\('error'/.test(s)) { skippedHas.push(f); continue }

  const i = hits[0]
  const indent = (lines[i].match(/^\s*/) ?? [''])[0]
  const block = [
    `${indent}// A failed \`spawn\` (bad exe path, permission denied) emits \`'error'\` and never writes to`,
    `${indent}// stdout, so without this handler the promise stayed pending until the 120 s timeout and`,
    `${indent}// reported 'boot timeout' for what was really a bad path. Unhandled, the event also crashes`,
    `${indent}// the process outright.`,
    `${indent}child.on('error', (error) => {`,
    `${indent}  clearTimeout(timer)`,
    `${indent}  reject(new Error(\`spawn failed for \${exe}: \${error.message}\`))`,
    `${indent}})`,
  ]
  lines.splice(i + 1, 0, ...block)
  writeFileSync(p, lines.join('\n'), 'utf8')
  changed += 1
}

console.log(`  已补 error 监听: ${changed}`)
console.log(`  已有监听（跳过）: ${skippedHas.length}  -> ${skippedHas.join(', ')}`)
console.log(`  有 2 处锚点（需手工，跳过）: ${skippedMulti.length}  -> ${skippedMulti.join(', ')}`)
console.log(`  无启动 promise（本就不 spawn DSH，跳过）: ${skippedNo.length}`)
