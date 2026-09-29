/**
 * Step ① acceptance: a New Session with no resolvable 底层工作区 reports it.
 *
 * The shipped behaviour is silence — `startSessionInDefaultWorkspace` returns the moment
 * the default Workspace fails to resolve, and because a deleted registration does not
 * throw, not even the failure toast fires. So the observable the user experiences is
 * "clicking New Session does nothing". This probe drives that exact situation and checks
 * the dialog replaces the silence.
 *
 * The missing state is produced the way a user produces it: delete the default
 * Workspace's **registration** (which retains its directory and Sessions by design).
 * Nothing on disk is removed.
 *
 * Checks:
 *   1. no dialog while the Workspace exists (the normal path stays silent);
 *   2. after the deletion, a New Session raises the dialog;
 *   3. the dialog names the derived path (the Host-derived one from step ①'s Remote);
 *   4. the three actions are stacked full-width and their labels do not overflow;
 *   5. the two repairs are disabled (they arrive in later steps);
 *   6. 取消 closes it and writes nothing;
 *   7. the dialog does not reappear after being cancelled.
 *
 * Usage: node probe-base-workspace-dialog.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-base-workspace-dialog.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = profile === 'pg' ? 17900 : 17901
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
      type: 'client-request',
      rpcId: `probe-${Math.random().toString(36).slice(2)}`,
      method,
      payload: { args },
    }),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch { /* raw text is printed on failure */ }
  return { status: response.status, text, value: parsed?.result?.value, ok: parsed?.result?.ok }
}, { method, args })

/** The missing-base-workspace dialog, found by its own title text. */
const dialog = () => page.locator('[role="dialog"], [aria-modal="true"]')
  .filter({ hasText: '底层工作区缺失' })

/** The plugin's durable state, which 取消 must not touch. */
const pluginState = () => {
  try {
    return readFileSync(join(dshHome, 'storages', 'project_groups.json'), 'utf8')
  } catch {
    return null
  }
}

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 1. 正常路径：默认工作区存在时不该弹窗 ===')
  const initialized = await rpc('workspace/initializeDefault', {})
  const workspace = initialized.value?.workspace ?? null
  console.log(`  默认工作区: ${String(workspace?.path)}`)
  if (workspace === null) throw new Error(`no default workspace: ${initialized.text.slice(0, 200)}`)

  // The shell's own New Session control, which is the unscoped entry.
  const newSession = page.getByRole('button', { name: /新建会话|新会话/ }).first()
  await newSession.click({ force: true })
  await page.waitForTimeout(6000)
  await dismiss()
  check('1) 正常路径下没有弹窗', await dialog().count() === 0)

  console.log('')
  console.log('=== 2. 删掉默认工作区的注册（保留目录与会话）===')
  const deleted = await rpc('workspace/delete', { request: { workspaceId: workspace.workspaceId } })
  console.log(`  deleted=${String(deleted.ok)}  ${deleted.text.slice(0, 120)}`)
  check('2) 注册已删除', deleted.ok === true)

  const stateBefore = pluginState()

  console.log('')
  console.log('=== 3. 现在点新建会话：应弹窗（而不是静默无反应）===')
  await newSession.click({ force: true })
  await page.waitForTimeout(6000)
  await dismiss()
  const appeared = await dialog().count()
  check('3) 弹窗出现（不再是静默无反应）', appeared === 1, `count=${String(appeared)}`)

  if (appeared !== 1) {
    console.log('  弹窗未出现，后续测量跳过')
  } else {
    /**
     * The dialog's geometry and copy, read off the live DOM.
     *
     * `textWidth` is measured with a canvas at the button's own computed font: a flex
     * child stretches to its cell, so `scrollWidth` reports the cell rather than the
     * label and would call every label a fit.
     */
    const shape = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      const found = dialogs.find(node => (node.textContent ?? '').includes('底层工作区缺失'))
      if (found === undefined) return { found: false }

      const buttons = [...found.querySelectorAll('button')]
        .filter(node => (node.textContent ?? '').trim() !== '')

      const naturalWidth = (label, element) => {
        const style = getComputedStyle(element)
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (context === null) return null
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        return Math.ceil(context.measureText(label).width)
      }

      return {
        found: true,
        text: (found.textContent ?? '').replace(/\s+/g, ' ').slice(0, 200),
        buttons: buttons.map(node => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
          const available = Math.round(rect.width - padding)
          const inner = (node.textContent ?? '').trim()
          const natural = naturalWidth(inner, node)
          return {
            label: inner,
            width: Math.round(rect.width),
            top: Math.round(rect.top),
            available,
            natural,
            fits: natural !== null && natural <= available,
            disabled: node.disabled,
          }
        }),
      }
    })

    console.log(`  弹窗文字: ${shape.text}`)
    console.log(`  按钮: ${JSON.stringify(shape.buttons.map(b => ({ label: b.label, w: b.width, y: b.top, disabled: b.disabled })))}`)

    check('3) 弹窗文案含"底层工作区缺失"', shape.text.includes('底层工作区缺失'))
    // The path comes from the Host via the new Remote; the dialog opens before the
    // round trip, so this waits for the annotated frame rather than sampling once.
    const pathShown = await page.waitForFunction(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      const found = dialogs.find(node => (node.textContent ?? '').includes('底层工作区缺失'))
      return found !== undefined && /[A-Za-z]:\\/.test(found.textContent ?? '')
    }, { timeout: 10_000 }).then(() => true).catch(() => false)
    check('3) 弹窗显示了 Host 推导的路径', pathShown)

    const labels = shape.buttons.map(b => b.label)
    check('4) 三个按钮竖排（top 递增）',
      shape.buttons.length === 3 && shape.buttons.every((b, i) => i === 0 || b.top > shape.buttons[i - 1].top),
      JSON.stringify(shape.buttons.map(b => b.top)))
    check('4) 三个按钮等宽全宽',
      shape.buttons.length === 3 && new Set(shape.buttons.map(b => b.width)).size === 1,
      JSON.stringify(shape.buttons.map(b => b.width)))
    check('4) 文案全部放得下（无溢出）', shape.buttons.every(b => b.fits),
      JSON.stringify(shape.buttons.map(b => `${b.label}:${b.natural}/${b.available}`)))

    const rebuild = shape.buttons.find(b => b.label.includes('重建'))
    const respecify = shape.buttons.find(b => b.label.includes('重新指定'))
    const cancel = shape.buttons.find(b => b.label === '取消')
    check('5) 「重建该工作区」在 ① 里是 disabled', rebuild?.disabled === true)
    check('5) 「重新指定底层工作区」在 ① 里是 disabled', respecify?.disabled === true)
    check('5) 「取消」可用', cancel !== undefined && cancel.disabled === false)

    console.log('')
    console.log('=== 4. 取消：关闭且不写任何数据 ===')
    await page.getByRole('button', { name: '取消', exact: true }).last().click({ force: true })
    await page.waitForTimeout(1500)
    check('4) 取消后弹窗关闭', await dialog().count() === 0)
    check('4) 取消后插件状态未变', pluginState() === stateBefore,
      pluginState() === stateBefore ? undefined : 'project_groups.json changed')

    console.log('')
    console.log('=== 5. 取消后再点：应再次弹窗（状态没被记住）===')
    await newSession.click({ force: true })
    await page.waitForTimeout(5000)
    await dismiss()
    check('5) 再次点击仍然弹窗', await dialog().count() === 1)
    await page.getByRole('button', { name: '取消', exact: true }).last().click({ force: true }).catch(() => {})
  }

  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED:\n  ${failures.join('\n  ')}`)
} finally {
  running.kill()
  await browser.close()
}
process.exit(failures.length === 0 ? 0 : 1)
