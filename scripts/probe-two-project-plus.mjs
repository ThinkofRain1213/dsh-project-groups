/**
 * What happens when two projects each get a ＋ click?
 *
 * Z-3 would make creating a project open a Session, by the same call a project
 * row's ＋ makes. Before adopting that, this measures what the ＋ path actually
 * does when a second project uses it: upstream's `reuseOrCreateBlank` reuses a
 * workspace's single blank Session, and every project here shares one workspace,
 * so the question is whether the second click moves the first project's Session
 * away or leaves it alone.
 *
 * The signal is the Session id itself, not a count: the same id appearing under
 * the second project means it MOVED, while a new id means each project has its
 * own. A count alone could not tell those apart.
 *
 * Usage: node probe-two-project-plus.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-two-project-plus.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = 17796
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const child = spawn(exe, [BIN, '--profile', profile, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`boot timeout:\n${out.slice(-1500)}`)), 120_000)
  child.stdout.on('data', (chunk) => {
    out += String(chunk)
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
    if (m !== null) { clearTimeout(timer); setTimeout(() => resolve(m[1]), 3000) }
  })
  child.stderr.on('data', (chunk) => { out += chunk })
})

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('pageerror', (error) => console.log(`pageerror: ${error.message}`))

const isMasked = () => page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
  .some(node => node.className.includes('mask')))
const dismiss = async () => {
  for (let i = 0; i < 8; i += 1) {
    if (!await isMasked()) return
    for (const label of ['稍后配置', '继续', 'Later']) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() > 0) {
        await button.click({ force: true }).catch(() => {})
        await page.waitForTimeout(1200)
      }
    }
    await page.waitForTimeout(700)
  }
}

const projectRow = (title) => page.locator('[data-row-key^="workspace:"]', { hasText: title }).first()

/** Every Session row with the project it is currently drawn under. */
const sessionRows = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-row-key]')]
  let group = null
  const found = []
  for (const node of rows) {
    const key = node.getAttribute('data-row-key')
    if (key.startsWith('workspace:')) { group = key.slice('workspace:'.length); continue }
    if (!key.startsWith('session:')) continue
    const rest = key.slice('session:'.length)
    const at = rest.indexOf('@')
    found.push({ id: rest.slice(0, at), drawnUnder: group, key })
  }
  return found
})

const makeProject = async (title) => {
  await dismiss()
  await page.locator('button[aria-label="新建项目"]').first().click()
  await page.waitForTimeout(800)
  await page.locator('input[aria-label="项目名称"]').first().fill(title)
  await page.getByRole('button', { name: '创建' }).first().click()
  await page.waitForTimeout(2500)
}

const clickPlus = async (title) => {
  const row = projectRow(title)
  await row.hover({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await row.locator('button[aria-label^="在"]').first().click({ force: true })
  await page.waitForTimeout(3000)
}

const report = async (label, keyA, keyB) => {
  const rows = await sessionRows()
  const a = rows.filter(r => r.key.endsWith(`@${keyA}`))
  const b = rows.filter(r => r.key.endsWith(`@${keyB}`))
  console.log(`\n--- ${label}`)
  console.log(`    A 名下会话: ${a.length === 0 ? '(无)' : a.map(r => r.id.slice(-8)).join(',')}`)
  console.log(`    B 名下会话: ${b.length === 0 ? '(无)' : b.map(r => r.id.slice(-8)).join(',')}`)
  return { a: a.map(r => r.id), b: b.map(r => r.id) }
}

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
await page.waitForTimeout(7000)
await dismiss()

const stamp = Date.now().toString(36)
const A = `甲${stamp}`
const B = `乙${stamp}`
await makeProject(A)
await makeProject(B)

const keyA = (await projectRow(A).getAttribute('data-row-key') ?? '').replace('workspace:', '')
const keyB = (await projectRow(B).getAttribute('data-row-key') ?? '').replace('workspace:', '')
console.log(`项目 A=${A} (${keyA.slice(0, 8)}…)  B=${B} (${keyB.slice(0, 8)}…)`)

const before = await report('两个项目刚建好，未点任何 ＋', keyA, keyB)
await clickPlus(A)
const afterA = await report('点了 A 的 ＋', keyA, keyB)
await clickPlus(B)
const afterB = await report('又点了 B 的 ＋', keyA, keyB)

console.log('\n================ 判定 ================')
const aIds = new Set(afterA.a)
const bIds = new Set(afterB.b)
const shared = [...aIds].filter(id => bIds.has(id))
console.log(`点 A 的 ＋ 后，A 名下: ${afterA.a.join(',') || '(无)'}`)
console.log(`点 B 的 ＋ 后，A 名下: ${afterB.a.join(',') || '(无)'}   B 名下: ${afterB.b.join(',') || '(无)'}`)
if (shared.length > 0) {
  console.log('★ 同一个会话同时/曾经出现在两边 ⇒ 第二个 ＋ 把第一个的会话挪走了')
} else if (afterB.a.length > 0 && afterB.b.length > 0) {
  console.log('两个项目各自持有会话 ⇒ 未发生争抢')
} else if (afterB.a.length === 0 && afterB.b.length > 0) {
  console.log('★ A 名下已空，会话只在 B ⇒ 会话被移走（不是新建）')
} else {
  console.log('结果需人工判读')
}
void before
console.log(`\n（首个报告对照）点之前: A=${before.a.length} B=${before.b.length}`)

await browser.close()
child.kill()
process.exit(0)
