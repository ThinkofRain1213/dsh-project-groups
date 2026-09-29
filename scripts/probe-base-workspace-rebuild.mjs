/**
 * Step 3b acceptance: 重建该工作区 makes the directory and registers it.
 *
 * This is the only action in the feature that writes to the disk, so the probe drives the real
 * button against a real `'specified'` setting whose directory is genuinely absent, and then checks
 * the two consequences that matter: the Session lands there afterwards, and the name the user chose
 * survives (the registry path can carry a title where `workspace/create` cannot).
 *
 * Checks:
 *   1. `specified` with a missing directory ⇒ rebuild creates it and registers it;
 *   2. afterwards an unscoped New Session lands in that Workspace (the dialog does not return);
 *   3. the registered title is the stored name, not the directory's basename;
 *   4. a rebuild over an existing directory is idempotent (no error, one row);
 *   5. `mkdir -p`: a path whose parents are gone is created all the way down;
 *   6. `'default'` mode is adopted into `'specified'`, because upstream's pointer is permanent
 *      ("deleting that registration permanently disables automatic creation") — and a New Session
 *      lands there rather than raising the dialog again;
 *   7. the dialog no longer repeats the "will create a directory" sentence on the report stage —
 *      as of 3b-2 that belongs to the confirmation stage, asserted by its own probe.
 *
 * Usage: node probe-base-workspace-rebuild.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-rebuild.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17973 : 17974
const BIN = `${asarRoot}\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`

const failures = []
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

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

/** Every New Session call, with the workspaceId it asked for. */
const requests = []
page.on('request', (request) => {
  const target = request.url()
  if (!target.includes('/api/')) return
  const method = target.split('/api/')[1]
  if (!/^(workspace|session)\//.test(method)) return
  let body = null
  try { body = JSON.parse(request.postData() ?? 'null') } catch { body = null }
  requests.push({ method, args: body?.payload?.args ?? {} })
})

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

const rpc = (method, args) => page.evaluate(async ({ method, args }) => {
  const token = new URL(location.href).searchParams.get('token') ?? ''
  const response = await fetch(`${location.origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-token': token },
    body: JSON.stringify({
      type: 'client-request', rpcId: `p-${Math.random().toString(36).slice(2)}`,
      method, payload: { args },
    }),
  })
  const parsed = JSON.parse(await response.text())
  return { ok: parsed?.result?.ok, value: parsed?.result?.value, error: parsed?.result?.error }
}, { method, args })

const registry = () => {
  try {
    const parsed = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    return Object.entries(parsed.tables?.workspaces ?? {}).map(([id, row]) => ({
      id, path: row.path, title: row.title,
    }))
  } catch {
    return []
  }
}
const storedBase = () => {
  try {
    return JSON.parse(readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')).global?.baseWorkspace ?? null
  } catch {
    return null
  }
}

// The dialog, **without** matching on its title: as of 3b-2 it has two stages with two titles
// (底层工作区缺失 / 确认重建), and a `hasText` filter for the first stops matching the moment the
// user confirms — which made this probe time out waiting for a button inside a dialog it believed
// was gone.
const missingDialog = () => page.locator('[role="dialog"], [aria-modal="true"]')
const chooserDialog = () => page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '选择底层工作区' })
const newSession = () => page.locator('button[aria-label="新建会话"], button[aria-label="新会话"]').first()

/**
 * Raise the report, press 重建该工作区, then confirm.
 *
 * Two clicks as of step 3b-2: the rebuild writes to the disk, so the dialog asks first (that stage
 * has its own probe, `probe-base-workspace-confirm.mjs`). This probe is about the effect, so it
 * walks both stages.
 * @returns the dialog text seen on the report stage, and whether it appeared.
 */
const pressRebuild = async () => {
  await newSession().click({ force: true })
  await page.waitForTimeout(5000)
  await dismiss()
  if (await missingDialog().count() === 0) return { appeared: false, hint: '' }
  const hint = (await missingDialog().first().innerText()).replace(/\s+/g, ' ')
  await missingDialog().getByRole('button', { name: '重建该工作区' }).first().click({ force: true })
  await page.waitForTimeout(1200)
  await missingDialog().getByRole('button', { name: '确认重建' }).first().click({ force: true })
  await page.waitForTimeout(6000)
  await dismiss()
  return { appeared: true, hint }
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 1. specified + 目录不存在 ⇒ 重建 ===')
  // A path under the isolated HOME that has never existed, with a name distinct from its basename
  // so check 3 can tell whether the stored title survived.
  const target = join(dshHome, 'rebuild-probe', 'important-folder')
  console.log(`  目标路径: ${target}`)
  console.log(`  存在吗（应为否）: ${String(existsSync(target))}`)
  check('起点：目录不存在', !existsSync(target))
  await rpc('projectGroups/setBaseWorkspace', {
    request: { mode: 'specified', path: target, name: '我给它起的名字' },
  })
  await page.waitForTimeout(1200)
  console.log(`  设置: ${JSON.stringify(storedBase())}`)

  const rebuilt = await pressRebuild()
  check('缺失弹窗出现', rebuilt.appeared === true)
  // The report stage no longer carries this sentence: as of 3b-2 it belongs to the confirmation
  // stage, which is where the write is actually authorised. Asserted there by
  // `probe-base-workspace-confirm.mjs` (check 1, "内容含警告文案").
  check('报告阶段不再重复那句提示', !rebuilt.hint.includes('创建目录'), rebuilt.hint.slice(0, 140))
  check('1) 目录已创建', existsSync(target))
  const rows = registry()
  const registered = rows.find(row => row.path === target)
  console.log(`  注册行: ${JSON.stringify(registered)}`)
  check('1) 目录已注册为工作区', registered !== undefined)
  check('1) 弹窗已关闭（重建成功）', await missingDialog().count() === 0)
  check('3) 标题是用户起的名字，不是 basename',
    registered?.title === '我给它起的名字', String(registered?.title))

  console.log('')
  console.log('=== 2. 重建后点 ＋ 应落在该工作区（不再弹窗）===')
  requests.length = 0
  await newSession().click({ force: true })
  await page.waitForTimeout(6000)
  await dismiss()
  const creates = requests.filter(entry => entry.method === 'session/create')
  const landed = creates[0]?.args?.request?.workspaceId ?? null
  console.log(`  session/create workspaceId: ${String(landed)}  期望: ${String(registered?.id)}`)
  check('2) 不再弹缺失弹窗', await missingDialog().count() === 0)
  check('2) 落在重建的工作区', landed === registered?.id, `${String(landed)} vs ${String(registered?.id)}`)

  console.log('')
  console.log('=== 4. 目录已存在时重建应幂等 ===')
  const beforeIdempotent = registry().filter(row => row.path === target).length
  const again = await pressRebuild()
  const afterRows = registry().filter(row => row.path === target)
  console.log(`  重建前条数=${String(beforeIdempotent)} 重建后条数=${String(afterRows.length)} 弹窗=${String(again.appeared)}`)
  check('4) 幂等：该路径仍只有一条', afterRows.length === 1, `${String(afterRows.length)} 条`)

  console.log('')
  console.log('=== 5. 父目录也不存在 ⇒ mkdir -p 一路建上去 ===')
  const deep = join(dshHome, 'rebuild-probe', 'gone', 'gone2', 'gone3', 'leaf')
  console.log(`  目标: ${deep}  目标存在: ${String(existsSync(deep))}  祖父存在: ${String(existsSync(join(dshHome, 'rebuild-probe', 'gone')))}`)
  check('起点：父目录不存在', !existsSync(join(dshHome, 'rebuild-probe', 'gone')))
  await rpc('projectGroups/setBaseWorkspace', { request: { mode: 'specified', path: deep, name: 'deep' } })
  await page.waitForTimeout(1200)
  const deepRebuild = await pressRebuild()
  check('5) 深层路径也重建成功', deepRebuild.appeared === true && existsSync(deep),
    `appeared=${String(deepRebuild.appeared)} exists=${String(existsSync(deep))}`)

  console.log('')
  console.log('=== 6. default 模式：重建后被采纳为 specified，且 ＋ 落点正常 ===')
  // Breaking the official default: delete its registration. Its pointer stays set by design, so the
  // dialog appears in `'default'` mode and a mkdir-only repair could not help.
  //
  // KNOWN LIMITATION, measured: this section cannot detect a wrong mkdir/create order, because the
  // default directory already exists on this machine — `create` therefore succeeds either way, and
  // the reverse control confirmed it passes. Making the premise honest would mean deleting that
  // directory, which is the **user's real** `~/Documents/deepseek-harness/default-workspace` (the
  // path derives from the OS Documents folder, not from `DSH_HOME`), so the ordering is covered by
  // sections 1, 2 and 5 instead, which use directories this probe creates. Asserting more here
  // would risk the user's data for a check that is already covered.
  const initial = await rpc('workspace/initializeDefault', {})
  const defaultWorkspace = initial.value?.workspace ?? null
  console.log(`  默认工作区: ${String(defaultWorkspace?.path)}`)
  await rpc('workspace/delete', { request: { workspaceId: defaultWorkspace.workspaceId } })
  await rpc('projectGroups/setBaseWorkspace', { request: { mode: 'default' } })
  await page.waitForTimeout(1200)
  console.log(`  设置: ${JSON.stringify(storedBase())}`)

  const defaultRebuild = await pressRebuild()
  console.log(`  重建后设置: ${JSON.stringify(storedBase())}`)
  check('6) default 模式下弹窗出现', defaultRebuild.appeared === true)
  check('6) 重建后被采纳为 specified', storedBase()?.mode === 'specified', JSON.stringify(storedBase()))
  check('6) 目录已重建', existsSync(defaultWorkspace.path))
  // The stored name belongs to the previous path (a memory survives a switch to 默认 by design), so
  // it must **not** be applied to the default directory. Found while reading this probe's own output:
  // the rebuilt setting carried `name: 'deep'` for `…default-workspace`.
  check('6) 没有沿用属于另一个路径的旧名字',
    storedBase()?.name !== 'deep', JSON.stringify(storedBase()))
  check('6) 标题取自该目录自身',
    storedBase()?.name === 'default-workspace', JSON.stringify(storedBase()?.name))
  const defaultRow = registry().find(row => row.path === defaultWorkspace.path)
  check('6) 注册行的标题也来自该目录', defaultRow?.title === 'default-workspace', String(defaultRow?.title))

  requests.length = 0
  await newSession().click({ force: true })
  await page.waitForTimeout(6000)
  await dismiss()
  const defaultCreates = requests.filter(entry => entry.method === 'session/create')
  const defaultLanded = defaultCreates[0]?.args?.request?.workspaceId ?? null
  console.log(`  落在: ${String(defaultLanded)}  弹窗: ${String(await missingDialog().count())}`)
  check('6) 不再弹缺失弹窗', await missingDialog().count() === 0)
  check('6) ＋ 落在重建后的工作区', defaultLanded !== null, String(defaultLanded))

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
