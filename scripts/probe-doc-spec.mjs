/**
 * The document-spec surface, end to end in a real browser.
 *
 * Covers the parts a source-level test cannot: that the settings card renders
 * the new controls, that the three-option group gates correctly, and that the
 * upload path really stores a file under the plugin's own directory.
 *
 * Usage: node probe-doc-spec.mjs <dshExe> <asarRoot> <dshHome> [profile]
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [exe, asarRoot, dshHome, profile = 'pg'] = process.argv.slice(2)
if (exe === undefined || asarRoot === undefined || dshHome === undefined) {
  console.error('usage: node probe-doc-spec.mjs <dshExe> <asarRoot> <dshHome> [profile]')
  process.exit(2)
}
const PORT = 17999
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
// Dark scheme deliberately: the flicker check measures painted pixels, and the
// dark card fill (53,54,56) sits far from the dark page (21,21,23) so a
// one-unit dip is unambiguous. The light theme's card is only ~2 units off its
// page, where the same measurement proves nothing. Every other assertion here
// resolves theme tokens at run time, so they hold in either scheme.
const page = await browser.newPage({
  viewport: { width: 1400, height: 900 },
  colorScheme: 'dark',
})
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

/** Invoke one Remote verb from inside the authenticated page. */
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
  return parsed?.result ?? parsed
}, { method, args })

const openCard = async () => {
  await dismiss()
  await page.locator('button[aria-label="插件"], [data-panel-id="plugins"]').first().click()
  await page.waitForTimeout(2500)
  await dismiss()
  await page.getByText('项目分组', { exact: true }).first().click({ force: true })
  await page.waitForTimeout(2500)
  await dismiss()
}

const specsDir = join(dshHome, 'project-groups', 'specs')
const storedSpecs = () => existsSync(specsDir) ? readdirSync(specsDir).sort() : []

let running = child
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await dismiss()

  console.log('=== 1. 设置卡渲染新控件 ===')
  await openCard()
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check('1) 文档规范组标题存在', body.includes('文档规范'), body.slice(0, 200))
  check('1) 无/默认/自定义 三张卡存在',
    body.includes('不更新格式') && body.includes('使用插件内置的规范') && body.includes('自定义'))
  // The 无 card states the POLICY, not just an absence: "不要求任何格式" alone can
  // be read as "rewrite it however you like", which would license reorganising a
  // document that already has a structure. Both branches of the policy are named.
  check('1) 「无」卡片说明两种情况',
    body.includes('无既定格式则自由书写') && body.includes('有既定格式则在其基础上书写'),
    body.slice(0, 300))
  check('1) 每项目开关存在', body.includes('为每项目单独调整文档规范'))

  console.log('')
  console.log('=== 2. 文档开关关时，规范组禁用（含灰显外观）===')
  const docSwitch = page.getByRole('switch', { name: '注入项目文档' }).first()
  check('2) 文档开关默认关', (await docSwitch.isChecked()) === false)
  const specCards = page.getByRole('button', { name: /使用插件内置的规范/ })
  check('2) 规范卡被禁用', await specCards.first().isDisabled())
  // The attribute alone is not the requirement: without a `:disabled` rule the
  // card keeps full contrast and reads as usable. That is exactly what shipped
  // once.
  //
  // The dimming must come from COLOUR, not `opacity`. An `opacity: .4` card is
  // its own compositing layer, and any switch animation on the page re-composites
  // it for a frame — measured as a one-unit brightness dip, reported as a flicker
  // and visible only while the card was gated. So: opacity must stay 1, and the
  // colour must differ from the enabled card's.
  const dimCheck = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('button[aria-pressed]')]
      .filter(c => /^无|^默认|^自定义/.test((c.textContent ?? '').trim()))
    const gated = cards.find(c => c.disabled === true && c.getAttribute('aria-pressed') === 'true')
    const gatedAny = cards.find(c => c.disabled === true)
    const enabled = cards.find(c => c.disabled === false && c.getAttribute('aria-pressed') === 'true')
    if (gatedAny === undefined) return null
    const gs = getComputedStyle(gatedAny)
    const sel = gated === undefined ? null : getComputedStyle(gated)
    const es = enabled === undefined ? null : getComputedStyle(enabled)
    return {
      gatedOpacity: gs.opacity,
      gatedColor: gs.color,
      enabledColor: es === null ? null : es.color,
      gatedBg: sel === null ? null : sel.backgroundColor,
      enabledBg: es === null ? null : es.backgroundColor,
    }
  })
  check('2) 禁用卡不使用 opacity（不得成为合成层）',
    dimCheck !== null && dimCheck.gatedOpacity === '1', JSON.stringify(dimCheck))
  // The gated fill must be an OPAQUE colour. The first fix mixed the module
  // surface with `transparent`, which leaves an alpha value to be composited a
  // second time; that extra rounding pass rendered rgb(34,35,36) where the
  // original gated appearance was rgb(34,34,36), and the user reported it as
  // "stuck on the flash colour". A hex/rgb fill has no such ambiguity.
  const opaqueFill = dimCheck !== null && dimCheck.gatedBg !== null
    && !/rgba\(|color\(srgb .* \/ 0?\.\d+\)/.test(dimCheck.gatedBg)
  check('2) 禁用卡的填充是不透明色（不得带 alpha）', opaqueFill,
    String(dimCheck?.gatedBg))
  // And it must equal the module surface at 40% over the page base — the exact
  // appearance `opacity: .4` produced. Computed here from the live tokens rather
  // than hard-coded, so a theme change does not break it.
  //
  // Chromium serializes a `color-mix` result as `color(srgb <0..1 floats>)`, not
  // `rgb(<0..255 ints>)`, so both sides are parsed into 0..255 ints first. Reading
  // those floats with a digit regex yields garbage (0.132549 → 0,132549,0), which
  // is what made the first version of this check report a false failure.
  const expectedFill = await page.evaluate(() => {
    const to255 = (spec) => {
      const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(spec)
      if (srgb !== null) return [1, 2, 3].map(i => Math.round(Number(srgb[i]) * 255))
      const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(spec)
      return rgb === null ? null : [1, 2, 3].map(i => Number(rgb[i]))
    }
    const read = (name) => {
      const p = document.createElement('div')
      document.body.append(p)
      p.style.color = `var(${name})`
      const v = getComputedStyle(p).color
      p.remove()
      return to255(v)
    }
    const module_ = read('--dsw-alias-bg-module-platform')
    const base = read('--dsw-alias-bg-base')
    const gated = [...document.querySelectorAll('button[aria-pressed="true"]')]
      .find(c => c.disabled === true)
    if (module_ === null || base === null || gated === undefined) return null
    const want = module_.map((v, i) => Math.round(0.4 * v + 0.6 * base[i]))
    const got = to255(getComputedStyle(gated).backgroundColor)
    return {
      want: want.join(','),
      got: got === null ? null : got.join(','),
      equal: got !== null && want.every((v, i) => v === got[i]),
    }
  })
  check('2) 禁用卡填充 = 模块表面色 ×40% 叠页面底色',
    expectedFill !== null && expectedFill.equal === true, JSON.stringify(expectedFill))
  check('2) 禁用卡文字色与启用卡不同（确实变灰）',
    dimCheck !== null && dimCheck.enabledColor !== null
    && dimCheck.gatedColor !== dimCheck.enabledColor, JSON.stringify(dimCheck))
  check('2) 选中的禁用卡底色与启用卡不同',
    dimCheck !== null && dimCheck.enabledBg !== null
    && dimCheck.gatedBg !== dimCheck.enabledBg, JSON.stringify(dimCheck))
  const perProject = page.getByRole('switch', { name: '为每项目单独调整文档规范' }).first()
  check('2) 每项目开关被禁用', await perProject.isDisabled())
  // The label beside a disabled Switch is plain markup, so it needs its own
  // gated class — the primitive only dims itself.
  const perProjectLabel = page.getByText('为每项目单独调整文档规范', { exact: true }).first()
  const labelColor = await perProjectLabel.evaluate(node => getComputedStyle(node).color)
  // Resolve the token the gated style is supposed to use, and read the same
  // token from a control that is genuinely disabled, so the comparison is
  // against the theme rather than against a hard-coded colour.
  const dimmed = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.color = 'var(--dsw-alias-label-dimmed)'
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  })
  console.log(`  每项目标题色: ${labelColor}（dimmed 令牌 = ${dimmed}）`)
  check('2) 每项目标题用的是 dimmed 令牌', labelColor === dimmed, `${labelColor} vs ${dimmed}`)
  // The 注入项目文档 row is gated by the MASTER switch, not by the document
  // switch tested above — so with the master on it is legitimately at full
  // contrast. The docket row is read while the master is off, further down.
  // Hovering a gated group must NOT strip the selected card's fill. A
  // `:disabled:hover { background: none }` rule of equal specificity did exactly
  // that, and the flash showed whenever the pointer crossed the columns.
  const hoverProbe = await page.evaluate(() => {
    const selected = [...document.querySelectorAll('button[aria-pressed="true"]')]
      .find(card => card.disabled === true)
    const rules = []
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText?.includes(':disabled:hover')) rules.push(rule.cssText)
        }
      } catch { /* cross-origin sheet */ }
    }
    return {
      fill: selected === undefined ? null : getComputedStyle(selected).backgroundColor,
      resettingRules: rules.length,
    }
  })
  console.log(`  选中卡探针: ${JSON.stringify(hoverProbe)}`)
  check('2) 选中卡在禁用态仍有底色', hoverProbe.fill !== null && hoverProbe.fill !== 'rgba(0, 0, 0, 0)',
    String(hoverProbe.fill))
  check('2) 没有 :disabled:hover 重置规则', hoverProbe.resettingRules === 0,
    String(hoverProbe.resettingRules))

  console.log('')
  console.log('=== 2c. 帧级：点无关开关时，禁用卡不得跳变 ===')
  // The flicker lived in the COMPOSITOR, not in the style tree: every computed
  // value was stable while the painted pixels dipped for a frame. A style poll
  // cannot see it, so this samples painted pixels from a CDP screencast, which
  // pushes a frame on every compositor paint.
  //
  // Run in the DARK theme: the dark card fill (53,54,56) is far from the dark
  // page (21,21,23), so a one-unit dip is unambiguous. The light theme's card is
  // only ~2 units from its page, which would make the measurement vacuous — which
  // is exactly how the first version of this check passed while measuring nothing.
  const flicker = await (async () => {
    const dark = await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
    const box = await page.evaluate(() => {
      // The SELECTED and disabled card, not merely any disabled one: an
      // unselected card's fill is transparent, so it paints the page colour and
      // a re-composite cannot show there. Only the filled, gated card carries the
      // compositing layer whose dimming flickered.
      const card = [...document.querySelectorAll('button[aria-pressed="true"]')]
        .find(c => c.disabled === true)
      const sw = [...document.querySelectorAll('button[role="switch"]')]
        .find(b => b.getAttribute('aria-label') === '新建项目时开启会话')
      if (card === undefined || sw === undefined) return null
      const r = card.getBoundingClientRect()
      const s = sw.getBoundingClientRect()
      const fill = getComputedStyle(card).backgroundColor
      return {
        card: { x: r.x, y: r.y, w: r.width, h: r.height },
        sw: { x: s.x + s.width / 2, y: s.y + s.height / 2 },
        vw: innerWidth, vh: innerHeight,
        fill,
        // A transparent fill would make the measurement vacuous; the caller
        // asserts this is a real surface.
        opaque: fill !== 'rgba(0, 0, 0, 0)' && fill !== 'transparent',
      }
    })
    if (box === null) return null
    let frames = []
    const cdp = await page.context().newCDPSession(page)
    cdp.on('Page.screencastFrame', async (event) => {
      frames.push(event.data)
      try { await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }) } catch { /* stopped */ }
    })
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1400, maxHeight: 1000 })
    await page.waitForTimeout(500)
    await page.mouse.move(20, 970)   // park the pointer away from every card
    await page.waitForTimeout(300)
    frames = []
    await page.mouse.click(box.sw.x, box.sw.y)
    await page.waitForTimeout(1000)
    const during = frames
    frames = []

    const modes = await page.evaluate(async ({ list, box, vw, vh }) => {
      const out = []
      for (const data of list) {
        const img = new Image()
        img.src = `data:image/png;base64,${data}`
        await img.decode()
        const sx = img.width / vw, sy = img.height / vh
        const px = Math.round((box.x + 8) * sx), py = Math.round((box.y + 8) * sy)
        const pw = Math.max(1, Math.round((box.w - 16) * sx)), ph = Math.max(1, Math.round((box.h - 16) * sy))
        const c = document.createElement('canvas')
        c.width = pw; c.height = ph
        const ctx = c.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, px, py, pw, ph, 0, 0, pw, ph)
        const d = ctx.getImageData(0, 0, pw, ph).data
        const hist = new Map()
        for (let i = 0; i < d.length; i += 4) {
          const k = `${d[i]},${d[i + 1]},${d[i + 2]}`
          hist.set(k, (hist.get(k) ?? 0) + 1)
        }
        out.push([...hist.entries()].sort((a, b2) => b2[1] - a[1])[0][0])
      }
      return out
    }, { list: during, box: box.card, vw: box.vw, vh: box.vh })
    await cdp.send('Page.stopScreencast').catch(() => {})
    if (modes.length < 3) return { frames: modes.length, dark, fill: box.fill }
    // The settled colour is the MODE over all frames, not the last one: taking
    // the last frame as "correct" would make a dip in that frame invisible.
    const counts = new Map()
    for (const m of modes) counts.set(m, (counts.get(m) ?? 0) + 1)
    const settled = [...counts.entries()].sort((a, b2) => b2[1] - a[1])[0][0].split(',').map(Number)
    // How far the painted card sits from the page colour. If this is small the
    // measurement could not show a one-unit dip, so the check must not pass.
    const pageColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const pageRgb = pageColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]
    const distinctFromPage = Math.max(...settled.map((v, k) => Math.abs(v - pageRgb[k]))) >= 8
    let maxDev = 0
    let devFrames = 0
    for (const m of modes) {
      const v = m.split(',').map(Number)
      const dev = Math.max(...v.map((n, k) => Math.abs(n - settled[k])))
      if (dev > maxDev) maxDev = dev
      if (dev >= 1) devFrames += 1
    }
    return {
      frames: modes.length, settled: settled.join(','), maxDev, devFrames, dark,
      fill: box.fill, opaque: box.opaque, distinctFromPage,
    }
  })()
  console.log(`  帧级探针: ${JSON.stringify(flicker)}`)
  check('2c) 帧级探针在深色主题下运行（否则测不出）',
    flicker !== null && flicker.dark === true, JSON.stringify(flicker))
  // Without this the check passes vacuously: an unselected card paints the page
  // colour, and a re-composite can never show there. The measured card must be a
  // filled, selected, gated one.
  check('2c) 测的是「选中的禁用卡」（有填充，非透明）',
    flicker !== null && flicker.opaque === true, JSON.stringify(flicker))
  check('2c) 测得的卡填充与页面底色可分辨（≥8）',
    flicker !== null && flicker.distinctFromPage === true, JSON.stringify(flicker))
  check('2c) 帧级无跳变（最大偏离 = 0）', flicker !== null && flicker.maxDev === 0,
    JSON.stringify(flicker))

  console.log('')
  console.log('=== 2b. master 关时，注入项目文档 行灰显 ===')
  // This row is gated by the MASTER switch, so it only dims once that is off —
  // and its label is plain markup, which is why it needed its own gated class.
  const masterSwitch = page.getByRole('switch', { name: '注入项目信息' }).first()
  await masterSwitch.click({ force: true })
  await page.waitForTimeout(2500)
  const docRow = await page.evaluate(() => {
    const title = [...document.querySelectorAll('div')]
      .find(n => n.textContent?.trim() === '注入项目文档' && n.children.length === 0)
    const probe = document.createElement('div')
    probe.style.color = 'var(--dsw-alias-label-dimmed)'
    document.body.append(probe)
    const token = getComputedStyle(probe).color
    probe.remove()
    return { color: title === undefined ? null : getComputedStyle(title).color, token }
  })
  console.log(`  注入项目文档 标题色: ${docRow.color}（dimmed = ${docRow.token}）`)
  check('2b) 注入项目文档 行灰显', docRow.color !== null && docRow.color === docRow.token,
    `${docRow.color} vs ${docRow.token}`)
  // Put the master back, so the rest of the probe runs against a live document
  // group.
  await masterSwitch.click({ force: true })
  await page.waitForTimeout(2500)

  console.log('')
  console.log('=== 3. 打开文档开关后解禁 ===')
  await docSwitch.click({ force: true })
  await page.waitForTimeout(2500)
  const specCardNow = page.getByRole('button', { name: /使用插件内置的规范/ })
  check('3) 规范卡恢复可用', (await specCardNow.first().isDisabled()) === false)

  console.log('')
  console.log('=== 3b. 自定义卡片自带「更换…」，没有路径输入框 ===')
  const customCard = page.getByRole('button', { name: /自定义/ }).first()
  // The rejected design put a read-only path field under the row. A text input
  // anywhere near this control is the regression to catch.
  const inputsInGroup = await customCard.evaluate((node) => {
    const group = node.closest('div')?.parentElement ?? node.parentElement
    return group?.querySelectorAll('input').length ?? -1
  })
  check('3b) 规范组内没有输入框', inputsInGroup === 0, `inputs=${inputsInGroup}`)
  // The chooser must live INSIDE the card, like the base-workspace card's 更换….
  const chooserInside = await customCard.evaluate(node =>
    [...node.querySelectorAll('[role="button"]')].some(el => el.textContent?.includes('更换')))
  check('3b) 「更换…」在自定义卡片内部', chooserInside)
  // The requirement is "the same control as the base-workspace card's 更换…",
  // so the two are compared directly rather than against a hard-coded style.
  const sameAsBaseChooser = await page.evaluate(() => {
    const read = (root) => {
      const action = [...root.querySelectorAll('span[role="button"]')]
        .find(el => el.textContent?.includes('更换'))
      if (action === undefined) return null
      const s = getComputedStyle(action)
      return `${s.borderTopWidth}|${s.borderRadius}|${s.padding}|${s.fontSize}`
    }
    const groups = [...document.querySelectorAll('div')]
    const custom = groups.find(g => [...g.querySelectorAll('button')]
      .some(b => b.textContent?.includes('自定义') && b.querySelector('span[role="button"]')))
    const base = groups.find(g => [...g.querySelectorAll('button')]
      .some(b => b.textContent?.includes('指定工作区')))
    return {
      custom: custom === undefined ? null : read(custom),
      base: base === undefined ? null : read(base),
    }
  })
  console.log(`  自定义卡片的更换…: ${sameAsBaseChooser.custom}`)
  console.log(`  底层工作区的更换…: ${sameAsBaseChooser.base}`)
  check('3b) 与「底层工作区」的更换… 同款样式',
    sameAsBaseChooser.custom !== null && sameAsBaseChooser.custom === sameAsBaseChooser.base,
    JSON.stringify(sameAsBaseChooser))

  console.log('')
  console.log('=== 3b-2. 自定义卡片的第二行随「高亮」动态变化 ===')
  // The line is dynamic on purpose. "This slot is empty" only matters to someone
  // RELYING on the slot, so the amber warning appears only while 自定义 is the
  // highlighted card; with 无/默认 selected the same empty slot is an ordinary
  // 「未选择」. Warning there would flag a slot nothing depends on.
  const readCardLine = async () => page.evaluate(() => {
    const cards = [...document.querySelectorAll('button[aria-pressed]')]
    const custom = cards.find(c => (c.querySelector('span')?.textContent ?? '').trim() === '自定义')
    const spans = [...(custom?.querySelectorAll('span') ?? [])]
    const line = spans.find(sp => {
      const text = (sp.textContent ?? '').trim()
      return text === '未选择' || text.includes('自动解析为无规范') || /\.md$/.test(text)
    })
    const pressed = (label) => [...document.querySelectorAll('button[aria-pressed]')]
      .find(c => (c.querySelector('span')?.textContent ?? '').trim() === label)?.getAttribute('aria-pressed')
    return {
      text: (line?.textContent ?? '').trim(),
      colour: line === undefined ? null : getComputedStyle(line).color,
      highlighted: ['无', '默认', '自定义'].find(l => pressed(l) === 'true') ?? null,
    }
  })
  const AMBER = 'rgb(245, 158, 11)'
  /** `--dsw-alias-label-tertiary`, what `.cubePath` paints by default. */
  const TERTIARY = 'rgb(173, 178, 184)'

  // (i) 自定义 highlighted, no usable spec → amber warning.
  await rpc('projectGroups/setDocSpecFileName', { request: { name: '' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'custom' } })
  await page.waitForTimeout(1600)
  let cardLineNow = await readCardLine()
  console.log(`  高亮=自定义 无可用: ${JSON.stringify(cardLineNow)}`)
  check('3b-2) 高亮自定义+无可用 ⇒ 警告文案',
    cardLineNow.text === '当前未选择规范，将自动解析为无规范', cardLineNow.text)
  check('3b-2) ...且用警告色', cardLineNow.colour === AMBER, String(cardLineNow.colour))

  // (ii)/(iii) 无/默认 highlighted → the ordinary wording and colour.
  for (const [mode, label] of [['default', '默认'], ['none', '无']]) {
    await rpc('projectGroups/setDocSpecMode', { request: { mode } })
    await page.waitForTimeout(1600)
    cardLineNow = await readCardLine()
    console.log(`  高亮=${label} 无可用: ${JSON.stringify(cardLineNow)}`)
    check(`3b-2) 高亮${label}+无可用 ⇒ 普通「未选择」`,
      cardLineNow.text === '未选择', cardLineNow.text)
    check(`3b-2) ...且用普通三级色`,
      cardLineNow.colour === TERTIARY, String(cardLineNow.colour))
  }

  // (iv) A usable file shows its name in the ordinary colour, whichever card is
  // highlighted — the line only describes the slot.
  await rpc('projectGroups/uploadSpec', { request: { name: 'card.md', content: '# card\n' } })
  await rpc('projectGroups/setDocSpecFileName', { request: { name: 'card.md' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'default' } })
  await page.waitForTimeout(1600)
  cardLineNow = await readCardLine()
  console.log(`  高亮=默认 有可用: ${JSON.stringify(cardLineNow)}`)
  check('3b-2) 有可用文件 ⇒ 显示文件名', cardLineNow.text === 'card.md', cardLineNow.text)
  check('3b-2) ...且用普通三级色', cardLineNow.colour === TERTIARY, String(cardLineNow.colour))
  // Restore the state 3b-3 expects: the 自定义 card must have NO usable file, so
  // clicking it opens the chooser instead of switching the mode. Leaving `card.md`
  // usable here silently changed that section's route.
  await rpc('projectGroups/setDocSpecFileName', { request: { name: '' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'custom' } })
  await page.waitForTimeout(1600)

  console.log('')
  console.log('=== 3b-3. 删除按钮必须有类样式（不是浏览器原生按钮）===')
  // `css.iconButton` was referenced but never defined, so the class resolved to
  // `undefined` and the control rendered as a default browser <button> — grey
  // fill, inset border. Asserted on computed style, because the failure mode is
  // "no styling at all" rather than "the wrong colour".
  //
  // A spec is uploaded first so the row (and therefore the button) exists; the
  // main upload section runs later and would not have provided one yet.
  await rpc('projectGroups/uploadSpec', {
    request: { name: 'btn-probe.md', content: '# button probe\n' },
  })
  await page.waitForTimeout(1200)
  // Reload so the client's cached `specs` includes it.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(6000)
  await openCard()
  await page.getByRole('button', { name: /自定义/ }).first().click({ force: true })
  await page.waitForTimeout(1500)
  const deleteStyle = await (async () => {
    const dlg = page.locator('[role="dialog"], [aria-modal="true"]').last()
    const del = dlg.getByRole('button', { name: /删除/ }).first()
    if (await del.count() === 0) return null
    return await del.evaluate((node) => {
      const s = getComputedStyle(node)
      return {
        className: String(node.className),
        width: s.width,
        height: s.height,
        background: s.backgroundColor,
        borderStyle: s.borderTopStyle,
        borderWidth: s.borderTopWidth,
        color: s.color,
      }
    })
  })()
  console.log(`  删除按钮: ${JSON.stringify(deleteStyle)}`)
  check('3b-3) 删除按钮渲染了 class（不是 undefined）',
    deleteStyle !== null && deleteStyle.className.trim() !== '', String(deleteStyle?.className))
  check('3b-3) 删除按钮无边框、背景透明（非原生外观）',
    deleteStyle !== null && deleteStyle.background === 'rgba(0, 0, 0, 0)'
    && (deleteStyle.borderStyle === 'none' || deleteStyle.borderWidth === '0px'),
    JSON.stringify(deleteStyle))
  check('3b-3) 删除按钮是 28×28 图标靶',
    deleteStyle !== null && deleteStyle.width === '28px' && deleteStyle.height === '28px',
    `${deleteStyle?.width}x${deleteStyle?.height}`)
  // Leave the picker. With nothing selected, 取消 now asks once before it leaves
  // (the "nothing selected" confirmation), so a single click no longer closes the
  // dialog — this helper follows through to the end.
  const leavePicker = async () => {
    const dlg = page.locator('[role="dialog"], [aria-modal="true"]').last()
    if (await dlg.count() === 0) return
    await dlg.getByRole('button', { name: '取消' }).first().click({ force: true })
    await page.waitForTimeout(1000)
    // The follow-up confirmation, when it appears, is dismissed with its own 取消
    // so nothing is written.
    const after = page.locator('[role="dialog"], [aria-modal="true"]').last()
    if (await after.count() > 0 && (await after.innerText()).includes('未选中任何规范')) {
      await after.getByRole('button', { name: '取消' }).first().click({ force: true })
      await page.waitForTimeout(1000)
    }
  }
  await leavePicker()
  // Leave the store as this section found it, so the later upload assertions
  // start from the state they expect.
  await rpc('projectGroups/deleteSpec', { request: { name: 'btn-probe.md' } })
  await page.waitForTimeout(1200)

  console.log('')
  console.log('=== 3c. 每项目下拉栏是「一行 + 选择器」，不是两行 + 按钮 ===')
  // Its rendering is checked through the project dialog, which needs the switch
  // on; the geometry read is the assertion that matters here.
  await page.getByRole('switch', { name: '为每项目单独调整文档规范' }).first().click({ force: true })
  await page.waitForTimeout(1500)
  const addProject = page.locator('button[aria-label="新建项目"]').first()
  await addProject.click({ force: true })
  await page.waitForTimeout(1200)
  const dialog = page.locator('[role="dialog"], [aria-modal="true"]').last()
  const specLabel = dialog.getByText('文档规范', { exact: true }).first()
  check('3c) 对话框里有文档规范标签', await specLabel.count() > 0)
  // One row means the label and the selector share a top coordinate.
  const geometry = await dialog.evaluate((node) => {
    const label = [...node.querySelectorAll('span')].find(el => el.textContent?.trim() === '文档规范')
    const selector = node.querySelector('button[aria-haspopup="menu"]')
    if (label === undefined || selector === null) return null
    const a = label.getBoundingClientRect(), b = selector.getBoundingClientRect()
    return { labelTop: Math.round(a.top), selectorTop: Math.round(b.top), selectorHeight: Math.round(b.height) }
  })
  console.log(`  几何: ${JSON.stringify(geometry)}`)
  check('3c) 标签与选择器同一行（垂直中心接近）',
    geometry !== null && Math.abs(geometry.labelTop - geometry.selectorTop) <= 8, JSON.stringify(geometry))
  check('3c) 选择器是紧凑控件（28px 左右，非全宽按钮）',
    geometry !== null && geometry.selectorHeight <= 32, String(geometry?.selectorHeight))
  // The pill must fit its own label: an earlier `max-width: 60%` resolved
  // against the pill's content-sized wrapper and clipped 「无（继承全局）」.
  const fits = await dialog.evaluate((node) => {
    const selector = node.querySelector('button[aria-haspopup="menu"]')
    const value = selector?.querySelector('span')
    if (value === null || value === undefined) return null
    return { text: value.textContent, scrollW: value.scrollWidth, clientW: value.clientWidth }
  })
  console.log(`  选择器内文字: ${JSON.stringify(fits)}`)
  check('3c) 选择器文字未被截断', fits !== null && fits.scrollW <= fits.clientW + 1,
    JSON.stringify(fits))

  // The list is fixed: `跟随全局 / 无 / 默认 / uploaded files…`, with 跟随全局 as
  // its own first row and no divider. It does NOT depend on what the global choice
  // is — that is the point of the row, see 3c-2.
  await dialog.locator('button[aria-haspopup="menu"]').first().click({ force: true })
  await page.waitForTimeout(700)
  const menuItems = await page.getByRole('menuitem').allInnerTexts()
  console.log(`  下拉项: ${JSON.stringify(menuItems)}`)
  check('3c) 第一项是「跟随全局」', menuItems[0]?.trim() === '跟随全局', JSON.stringify(menuItems))
  check('3c) 第二项是「无」', menuItems[1]?.trim() === '无', JSON.stringify(menuItems))
  check('3c) 第三项是「默认」', menuItems[2]?.trim() === '默认', JSON.stringify(menuItems))
  check('3c) 三项语义固定，其余是文件名',
    menuItems.length >= 3 && !menuItems.slice(3).some(x => /^(跟随全局|无|默认)$/.test(x.trim())),
    JSON.stringify(menuItems))
  // No inheritance marker anywhere: it was replaced by the explicit first row.
  check('3c) 不再有「继承全局」标记',
    menuItems.every(x => !x.includes('继承全局')), JSON.stringify(menuItems))
  // No divider: every entry is a selectable row.
  check('3c) 没有分隔线', (await page.getByRole('separator').count()) === 0,
    String(await page.getByRole('separator').count()))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await dialog.getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(700)

  console.log('')
  console.log('=== 3c-2. 下拉栏与全局选择无关（这是显式行取代标记的理由）===')
  // The whole reason 跟随全局 is a row rather than a suffix: a marker had to decide
  // WHICH entry was "the global one", and with a global choice of 自定义-but-empty
  // there is no such entry — the value is 无 while the choice is 自定义. An explicit
  // row removes the question, so the list is IDENTICAL across every global state.
  const openNewProject = async () => {
    await page.locator('button[aria-label="新建项目"]').first().click({ force: true })
    await page.waitForTimeout(2000)
    return page.locator('[role="dialog"], [aria-modal="true"]').last()
  }
  const pillValue = async (dlg) => dlg.evaluate((node) => {
    const span = node.querySelector('button[aria-haspopup="menu"] span')
    return span === null || span === undefined ? null : (span.textContent ?? '').trim()
  })
  const menuOf = async (dlg) => {
    await dlg.locator('button[aria-haspopup="menu"]').first().click({ force: true })
    await page.waitForTimeout(700)
    const items = await page.getByRole('menuitem').allInnerTexts()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    return items.map(x => x.trim())
  }
  await rpc('projectGroups/uploadSpec', { request: { name: 'inherit.md', content: '# inherit\n' } })
  await page.waitForTimeout(1200)
  for (const [mode, name] of [
    ['custom', ''],
    ['custom', 'ghost.md'],
    ['none', ''],
    ['default', ''],
    ['custom', 'inherit.md'],
  ]) {
    await rpc('projectGroups/setDocSpecFileName', { request: { name } })
    await rpc('projectGroups/setDocSpecMode', { request: { mode } })
    await page.waitForTimeout(1500)
    const dlg = await openNewProject()
    // A fresh project has no override, so the pill must read 跟随全局 whatever the
    // global choice is.
    const got = await pillValue(dlg)
    const items = await menuOf(dlg)
    const label = name === '' ? '空名' : name === 'ghost.md' ? '悬空名' : name
    console.log(`  全局 mode=${mode} name=${label} → 选中 ${JSON.stringify(got)} 列表 ${JSON.stringify(items)}`)
    check(`3c-2) 全局 ${mode}/${label} 时，新项目仍选中「跟随全局」`, got === '跟随全局', String(got))
    check(`3c-2) ...且列表前三位固定、其余全是文件名`,
      items[0] === '跟随全局' && items[1] === '无' && items[2] === '默认'
      && items.slice(3).every(x => x.endsWith('.md')), JSON.stringify(items))
    await dlg.getByRole('button', { name: '取消' }).first().click({ force: true })
    await page.waitForTimeout(1200)
  }
  // Leave the global choice on 自定义 so the sections that follow find a file-based
  // spec rather than the built-in one.
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'custom' } })
  await rpc('projectGroups/setDocSpecFileName', { request: { name: 'inherit.md' } })
  await page.waitForTimeout(1500)

  console.log('')
  console.log('=== 3c-3. 覆盖值的四种存储状态各自选中哪一行 ===')
  // The list is fixed, so what varies is the SELECTED row. A stale file name
  // selects 跟随全局 because that is what it resolves to — the row states what is in
  // effect, the same rule the settings card follows.
  //
  // `'default'` is included because it was BROKEN: the Host's file-name guard
  // rejected it ("not a usable spec file name"), so picking 默认 silently kept the
  // previous value. Its presence here is the regression test for that fix.
  // `rpc` here returns the server's `result` object directly — `{ ok, value }` or
  // `{ ok: false, error }` — so refusals are readable without a second unwrap.
  const overrideProbe = await rpc('projectGroups/create', {
    request: { title: '覆盖规则探针', directories: [] },
  })
  const overrideProjectId = overrideProbe?.value?.project?.projectId
  check('3c-3) 建了一个用于覆盖规则的项目', typeof overrideProjectId === 'string',
    String(overrideProjectId))
  const setOverride = async (spec) => {
    const reply = await rpc('projectGroups/setProjectDocSpec', {
      request: { projectId: overrideProjectId, spec },
    })
    await page.waitForTimeout(1400)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(6000)
    await openCard()
    return reply
  }
  const openOverrideEdit = async () => {
    const row = page.locator('[data-row-key^="workspace:"]').filter({ hasText: '覆盖规则探针' }).first()
    await row.hover({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
    const trigger = row.locator(
      'button[aria-label*="项目"][aria-label*="操作"], button[aria-label*="更多"], button[aria-label*="菜单"]',
    ).first()
    if (await trigger.count() > 0) await trigger.click({ force: true })
    else await row.locator('button[aria-haspopup="menu"]').first().click({ force: true })
    await page.waitForTimeout(800)
    await page.getByRole('menuitem', { name: /编辑项目/ }).first().click({ force: true })
    await page.waitForTimeout(1500)
    return page.locator('[role="dialog"], [aria-modal="true"]').filter({ hasText: '编辑项目' }).first()
  }
  for (const [spec, expect] of [
    [null, '跟随全局'],
    ['none', '无'],
    ['default', '默认'],
    ['inherit.md', 'inherit.md'],
    ['ghost.md', '跟随全局'],
  ]) {
    const reply = await setOverride(spec)
    const accepted = reply?.ok === true
    const dlg = await openOverrideEdit()
    const pill = await pillValue(dlg)
    const label = spec === null ? 'null' : JSON.stringify(spec)
    console.log(`  覆盖=${label} 写入接受=${accepted} → 选中 ${JSON.stringify(pill)}`)
    check(`3c-3) 覆盖 ${label} 写入被接受`, accepted,
      JSON.stringify(reply?.error ?? '(ok)'))
    check(`3c-3) 覆盖 ${label} ⇒ 选中「${expect}」`, pill === expect, String(pill))
    await dlg.getByRole('button', { name: '取消' }).first().click({ force: true })
    await page.waitForTimeout(1000)
  }

  console.log('')
  console.log('=== 3c-4. 新建对话框选的规范必须真的存下来 ===')
  // The dialogue collected and DISPLAYED the choice while the client action
  // destructured only `{ title, directories }`, so it was discarded on save. The
  // edit dialog was unaffected, which is what made this a one-sided bug — and why
  // the assertion runs the REAL create path rather than calling `create` directly,
  // since the direct verb was never the broken link.
  const createPicking = async (title, spec) => {
    await page.locator('button[aria-label="新建项目"]').first().click({ force: true })
    await page.waitForTimeout(2000)
    const dlg = page.locator('[role="dialog"], [aria-modal="true"]').last()
    await dlg.locator('input[type="text"], input:not([type])').first().fill(title)
    await page.waitForTimeout(400)
    if (spec !== null) {
      await dlg.locator('button[aria-haspopup="menu"]').first().click({ force: true })
      await page.waitForTimeout(800)
      const label = spec === 'default' ? '默认' : spec === 'none' ? '无' : spec
      await page.getByRole('menuitem', { name: label, exact: true }).first().click({ force: true })
      await page.waitForTimeout(600)
    }
    await dlg.getByRole('button', { name: /新建|创建|确认/ }).last().click({ force: true })
    await page.waitForTimeout(3000)
    // `readSpec` is defined further down, so read the baseline directly here.
    const s = await rpc('projectGroups/baseline', {})
    return (s?.value ?? s)?.projects?.find(p => p.title === title)
  }
  for (const [spec, expect, label] of [
    ['inherit.md', 'inherit.md', '已上传规范'],
    ['default', 'default', '默认'],
    ['none', 'none', '无'],
    [null, undefined, '不选（跟随全局）'],
  ]) {
    const created = await createPicking(`新建存${label}`, spec)
    console.log(`  新建选「${label}」→ docSpec=${JSON.stringify(created?.docSpec)}`)
    check(`3c-4) 新建选「${label}」后 docSpec 正确保存`,
      created !== undefined && created.docSpec === expect, JSON.stringify(created?.docSpec))
  }

  console.log('')
  console.log('=== 3d. 对话框的规范行遵守与设置卡相同的三重门控 ===')
  // The row shipped gated on the per-project switch alone, so it appeared while
  // 注入项目信息 was off — a spec setting for a document that is never
  // described, and one the settings page showed as unavailable. The dialog must
  // require all three.
  const gateRow = async () => {
    await page.locator('button[aria-label="新建项目"]').first().click({ force: true })
    await page.waitForTimeout(1200)
    const present = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].pop()
      if (dlg === undefined) return null
      return [...dlg.querySelectorAll('span')].some(s => s.textContent?.trim() === '文档规范')
    })
    await page.locator('[role="dialog"], [aria-modal="true"]').last()
      .getByRole('button', { name: '取消' }).first().click({ force: true })
    await page.waitForTimeout(800)
    return present
  }
  for (const info of [true, false]) {
    for (const doc of [true, false]) {
      await rpc('projectGroups/setInjectProjectInfo', { request: { value: info } })
      await rpc('projectGroups/setInjectProjectDoc', { request: { value: doc } })
      await rpc('projectGroups/setPerProjectDocSpec', { request: { value: true } })
      await page.waitForTimeout(1800)
      const present = await gateRow()
      const expected = info && doc
      check(`3d) 信息=${info ? '开' : '关'} 文档=${doc ? '开' : '关'} → 规范行${expected ? '有' : '无'}`,
        present === expected, `实测 ${present}`)
    }
  }
  // Restore: all three on, which the later checks expect.
  await rpc('projectGroups/setInjectProjectInfo', { request: { value: true } })
  await rpc('projectGroups/setInjectProjectDoc', { request: { value: true } })
  await rpc('projectGroups/setPerProjectDocSpec', { request: { value: true } })
  await page.waitForTimeout(1800)

  console.log('')
  console.log('=== 3e. 「自定义」不得停在无文件的状态，空列表可确认 ===')
  // Three related rules, each of which shipped broken:
  //
  //  a. clicking 自定义 with no usable file must OPEN THE PICKER AND WRITE
  //     NOTHING. It used to write `'custom'` first, so cancelling left
  //     mode='custom' with an empty name — the illegal "empty custom" state.
  //  b. an empty list must be CONFIRMABLE, and confirming must commit the default
  //     spec, not an empty 'custom'.
  //  c. the two writes that used to be fired together (`setDocSpecFileName` +
  //     `setDocSpecMode`) lost one another in 12 of 12 measured runs, because both
  //     are read-modify-write over the same record. The Host now serializes them.
  const modeCard = page.getByRole('button', { name: /^自定义/ }).first()
  const specDialog = () => page.locator('[role="dialog"], [aria-modal="true"]').last()
  const readSpec = async () => {
    const r = await rpc('projectGroups/baseline', {})
    return r?.result?.value ?? r?.value ?? {}
  }

  // (a) no usable file → the card opens the picker and writes nothing on 取消.
  //
  // 取消 now means exactly "close without writing", for every mode. It used to
  // raise a second dialog when nothing was selected, and that dialog's own 取消
  // tore the whole stack down — so the button could not be relied on either way.
  await rpc('projectGroups/setDocSpecFileName', { request: { name: '' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'default' } })
  await page.waitForTimeout(1500)
  await modeCard.click({ force: true })
  await page.waitForTimeout(1500)
  check('3e-a) 无可用文件时点「自定义」弹出选择对话框',
    (await specDialog().innerText()).includes('选择文档规范'))
  await specDialog().getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(1200)
  check('3e-a) 取消只关闭一层，不弹第二层',
    (await page.locator('[role="dialog"], [aria-modal="true"]').count()) === 0)
  let specState = await readSpec()
  check('3e-a) 取消后 mode 未被写成 custom，也未改成无', specState.docSpecMode === 'default',
    String(specState.docSpecMode))

  // (a2) The same exits on 无 must also write nothing.
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'none' } })
  await page.waitForTimeout(1500)
  await page.locator('span[role="button"]', { hasText: '更换' }).first().click({ force: true })
  await page.waitForTimeout(1500)
  await specDialog().getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(1200)
  check('3e-a2) 「无」模式下取消只关闭一层',
    (await page.locator('[role="dialog"], [aria-modal="true"]').count()) === 0)
  specState = await readSpec()
  check('3e-a2) 「无」模式下取消不改动设置', specState.docSpecMode === 'none',
    String(specState.docSpecMode))

  // (a3) With a NON-EMPTY list but nothing selected, the notice uses the other
  // wording. The spec is uploaded here because this is what makes the list
  // non-empty; without it the empty-list wording appears and the assertion would
  // be testing a different branch.
  await rpc('projectGroups/uploadSpec', { request: { name: 'seeded.md', content: '# seeded\n' } })
  await rpc('projectGroups/setDocSpecFileName', { request: { name: 'ghost.md' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'custom' } })
  await page.waitForTimeout(1500)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(6000)
  await openCard()
  await page.locator('span[role="button"]', { hasText: '更换' }).first().click({ force: true })
  await page.waitForTimeout(1500)
  const staleNotice = (await specDialog().locator('[role="status"]').first().innerText()).trim()
  console.log(`  非空未选中提示: ${staleNotice}`)
  check('3e-a3) 未选中时对话框内显示橙色提示',
    staleNotice === '当前未选中任何规范，使用自定义规范时将自动解析为无规范', staleNotice)
  // The wording says "will resolve", not "confirming will fall back": confirming
  // no longer changes the mode, so blaming the click would be wrong.
  check('3e-a3) 提示不声称"确认"导致回退', !staleNotice.includes('确认将'), staleNotice)
  check('3e-a3) 提示只有一层（没有第二层弹窗）',
    (await page.locator('[role="dialog"], [aria-modal="true"]').count()) === 1)
  check('3e-a3) 「确认」未被禁用',
    (await specDialog().getByRole('button', { name: '确认' }).first().isDisabled()) === false)
  // 取消 leaves the setting untouched — including the remembered name.
  await specDialog().getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(1200)
  specState = await readSpec()
  check('3e-a3) 取消后 mode 仍是 custom，名字仍在',
    specState.docSpecMode === 'custom' && specState.docSpecFileName === 'ghost.md',
    `${specState.docSpecMode}/${specState.docSpecFileName}`)

  // (a4) 确认 with nothing selected empties the 自定义 slot and moves NO highlight.
  //
  // The highlight moves for one reason only: the user clicked a card. This dialog
  // edits the slot's value; emptying it is a legitimate state that already
  // resolves to "no format required" (see `resolveSpec`), and the card's own amber
  // line says so. Writing `'none'` here would make the dialog choose a mode.
  await page.locator('span[role="button"]', { hasText: '更换' }).first().click({ force: true })
  await page.waitForTimeout(1500)
  await specDialog().getByRole('button', { name: '确认' }).first().click({ force: true })
  await page.waitForTimeout(1800)
  specState = await readSpec()
  check('3e-a4) 未选中时确认清空「自定义」格的值',
    specState.docSpecFileName === '', JSON.stringify(specState.docSpecFileName))
  check('3e-a4) 确认不改变 mode（仍 custom）', specState.docSpecMode === 'custom',
    String(specState.docSpecMode))
  const nonePressed = await page.evaluate(() => {
    const pick = (label) => [...document.querySelectorAll('button[aria-pressed]')]
      .find(c => (c.querySelector('span')?.textContent ?? '').trim() === label)
    return {
      none: pick('无')?.getAttribute('aria-pressed'),
      custom: pick('自定义')?.getAttribute('aria-pressed'),
    }
  })
  check('3e-a4) 高亮没有跳到「无」（只有点卡片才移动）',
    nonePressed.none === 'false' && nonePressed.custom === 'true', JSON.stringify(nonePressed))

  // (a5) With the list EMPTY the notice uses its own wording. Distinct from (a3),
  // which covers a non-empty list with no row picked: the causes differ and the
  // user can act on them differently (upload vs click), even though the outcome is
  // the same. Both were reworded when confirming stopped changing the mode —
  // "确认将回退到无" claimed the click caused the fallback, which is no longer true.
  const seededNow = (await readSpec()).specs ?? []
  for (const name of seededNow) {
    await rpc('projectGroups/deleteSpec', { request: { name } })
  }
  await rpc('projectGroups/setDocSpecFileName', { request: { name: '' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'custom' } })
  await page.waitForTimeout(1500)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(6000)
  await openCard()
  await page.locator('span[role="button"]', { hasText: '更换' }).first().click({ force: true })
  await page.waitForTimeout(1500)
  const emptyNotice = (await specDialog().locator('[role="status"]').first().innerText()).trim()
  console.log(`  空列表提示: ${emptyNotice}`)
  check('3e-a5) 空列表提示用空列表文案',
    emptyNotice === '当前列表为空，使用自定义规范时将自动解析为无规范', emptyNotice)
  check('3e-a5) 提示不再声称"确认"导致回退', !emptyNotice.includes('确认将'), emptyNotice)
  await specDialog().getByRole('button', { name: '取消' }).first().click({ force: true })
  await page.waitForTimeout(1200)

  // (b) 更换… replaces the MEMORY and leaves the MODE alone.
  //
  // Two entry points share one chooser and they mean different things: the 自定义
  // CARD (when it has no usable file) asks for that mode, while 更换… only replaces
  // the remembered file. Confirming used to write `'custom'` unconditionally, so
  // replacing the file while 默认 was selected also jumped the card.
  //
  // Both halves are asserted: the new name IS written (a real replacement, not a
  // discarded request) and the mode did NOT move.
  //
  // The specs are created here: the main upload section runs later, so without
  // this there is nothing to preselect and the first assertion would test nothing.
  await rpc('projectGroups/uploadSpec', { request: { name: 'probe-spec.md', content: '# one\n' } })
  await rpc('projectGroups/uploadSpec', { request: { name: 'other.md', content: '# other\n' } })
  await rpc('projectGroups/setDocSpecFileName', { request: { name: 'probe-spec.md' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'default' } })
  await page.waitForTimeout(1500)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(6000)
  await openCard()
  await page.locator('span[role="button"]', { hasText: '更换' }).first().click({ force: true })
  await page.waitForTimeout(1500)
  check('3e-f1) 「默认」下滑换… 仍预选记忆里的文件名',
    (await specDialog().locator('[role="option"][aria-selected="true"]').count()) === 1)
  // Replace it with the OTHER spec so the write is provably a change.
  await specDialog().getByRole('option').filter({ hasText: 'other.md' }).first().click({ force: true })
  await page.waitForTimeout(500)
  await specDialog().getByRole('button', { name: '确认' }).first().click({ force: true })
  await page.waitForTimeout(1800)
  specState = await readSpec()
  check('3e-f2) 更换… 确实写入了新文件名', specState.docSpecFileName === 'other.md',
    JSON.stringify(specState.docSpecFileName))
  check('3e-f3) 更换… 不改变 mode（仍 default）', specState.docSpecMode === 'default',
    String(specState.docSpecMode))
  const cardPressed = await page.evaluate(() => {
    const pick = (label) => [...document.querySelectorAll('button[aria-pressed]')]
      .find(c => (c.querySelector('span')?.textContent ?? '').trim() === label)
    return {
      custom: pick('自定义')?.getAttribute('aria-pressed'),
      def: pick('默认')?.getAttribute('aria-pressed'),
    }
  })
  check('3e-f4) 卡片高亮没有跳到「自定义」',
    cardPressed.custom === 'false' && cardPressed.def === 'true', JSON.stringify(cardPressed))

  // (c) the two writes must both survive when fired together.
  await rpc('projectGroups/setDocSpecFileName', { request: { name: 'probe-spec.md' } })
  await Promise.all([
    rpc('projectGroups/setDocSpecFileName', { request: { name: 'probe-spec.md' } }),
    rpc('projectGroups/setDocSpecMode', { request: { mode: 'custom' } }),
  ])
  await page.waitForTimeout(1200)
  specState = await readSpec()
  check('3e-c) 并发写入文件名与模式都存活（无丢失更新）',
    specState.docSpecFileName === 'probe-spec.md' && specState.docSpecMode === 'custom',
    JSON.stringify({ name: specState.docSpecFileName, mode: specState.docSpecMode }))

  // (b) nothing selected → confirm → no spec.
  //
  // The outcome the notice describes is what `resolveSpec` already does with no
  // file (a 'custom' with no readable file resolves to none); confirming does not
  // cause it, and no longer writes a mode. The notice's wording is asserted
  // against that behaviour rather than against a write.
  for (const name of specState.specs) {
    await rpc('projectGroups/deleteSpec', { request: { name } })
  }
  await page.waitForTimeout(1500)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(6000)
  await openCard()
  // 更换… opens the picker; the card itself only does so when nothing is usable.
  await page.locator('span[role="button"]', { hasText: '更换' }).first().click({ force: true })
  await page.waitForTimeout(1500)
  const emptyText = (await specDialog().innerText()).replace(/\s+/g, ' ')
  check('3e-b) 空列表时显示橙色提示（不是第二层弹窗）',
    emptyText.includes('当前列表为空') && emptyText.includes('自动解析为无规范'),
    emptyText.slice(0, 70))
  check('3e-b) 空列表时只有一个对话框',
    (await page.locator('[role="dialog"], [aria-modal="true"]').count()) === 1)
  const emptyConfirm = specDialog().getByRole('button', { name: '确认' }).first()
  check('3e-b) 空列表「确认」可点（不再禁用死锁）',
    (await emptyConfirm.isDisabled()) === false)
  const modeBeforeB = (await readSpec()).docSpecMode
  // One click commits: no second dialog to get through.
  await emptyConfirm.click({ force: true })
  await page.waitForTimeout(1500)
  check('3e-b) 确认后没有第二层弹窗，对话框直接关闭',
    (await page.locator('[role="dialog"], [aria-modal="true"]').count()) === 0)
  specState = await readSpec()
  check('3e-b) 确认后名字被清空（与提示一致）',
    specState.docSpecFileName === '', JSON.stringify(specState.docSpecFileName))
  // The rule this pins: the chooser edits the 自定义 slot's VALUE only. Whatever
  // the highlight was before the dialog opened, it is unchanged after.
  check('3e-b) 确认不改变 mode',
    specState.docSpecMode === modeBeforeB, `${modeBeforeB} → ${specState.docSpecMode}`)
  const afterNone = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('button[aria-pressed]')]
      .filter(c => /^无|^默认|^自定义/.test((c.textContent ?? '').trim()))
    const pick = (label) => cards.find(c => (c.querySelector('span')?.textContent ?? '').trim() === label)
    return {
      none: pick('无')?.getAttribute('aria-pressed'),
      custom: pick('自定义')?.getAttribute('aria-pressed'),
    }
  })
  check('3e-b) 高亮仍停在打开前的那张卡（未跳到「无」）',
    afterNone.none === (modeBeforeB === 'none' ? 'true' : 'false')
    && afterNone.custom === (modeBeforeB === 'custom' ? 'true' : 'false'),
    `before=${modeBeforeB} after=${JSON.stringify(afterNone)}`)

  // (b2) The other two modes must behave identically: the empty confirm is not a
  // mode change in ANY of them. This is the case that was wrong before — 默认
  // used to be turned into 无 by confirming an empty chooser.
  for (const [mode, label] of [['default', '默认'], ['none', '无'], ['custom', '自定义']]) {
    await rpc('projectGroups/setDocSpecFileName', { request: { name: 'ghost.md' } })
    await rpc('projectGroups/setDocSpecMode', { request: { mode } })
    await page.waitForTimeout(1500)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(6000)
    await openCard()
    await page.locator('span[role="button"]', { hasText: '更换' }).first().click({ force: true })
    await page.waitForTimeout(1500)
    const pre = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].pop()
      return [...(dlg?.querySelectorAll('[role="option"]') ?? [])]
        .filter(o => o.getAttribute('aria-selected') === 'true').length
    })
    check(`3e-b2) ${label}：空确认前未预选任何行`, pre === 0, `selected=${pre}`)
    await specDialog().getByRole('button', { name: '确认' }).first().click({ force: true })
    await page.waitForTimeout(1800)
    specState = await readSpec()
    check(`3e-b2) ${label}：空确认后 mode 仍是 ${mode}`,
      specState.docSpecMode === mode, String(specState.docSpecMode))
    const pressedNow = await page.evaluate((lab) => {
      const pick = (label) => [...document.querySelectorAll('button[aria-pressed]')]
        .find(c => (c.querySelector('span')?.textContent ?? '').trim() === label)
      return pick(lab)?.getAttribute('aria-pressed')
    }, label)
    check(`3e-b2) ${label}：高亮仍在「${label}」`, pressedNow === 'true', String(pressedNow))
  }

  // (d) A stale name must not be displayed, and the highlight must NOT move.
  //
  // The precondition is set explicitly: 3e-b left `mode='none'`, so without this
  // the stored mode would already be 无 and the assertion would test nothing.
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'custom' } })
  await rpc('projectGroups/setDocSpecFileName', { request: { name: 'ghost.md' } })
  await page.waitForTimeout(2000)
  const ghost = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('button[aria-pressed]')]
      .filter(c => /^无|^默认|^自定义/.test((c.textContent ?? '').trim()))
    const cardOf = (label) => cards.find(c => (c.querySelector('span')?.textContent ?? '').trim() === label)
    const custom = cardOf('自定义')
    const value = [...(custom?.querySelectorAll('span') ?? [])]
      .find(s => /自动解析为无规范|\.md/.test(s.textContent ?? ''))
    const pick = (label) => [...document.querySelectorAll('button[aria-pressed]')]
      .find(c => (c.querySelector('span')?.textContent ?? '').trim() === label)
    return {
      text: (value?.textContent ?? '').trim(),
      colour: value === undefined ? null : getComputedStyle(value).color,
      hasTitle: custom?.querySelector('span[title]') !== null
        && custom?.querySelector('span[title]') !== undefined,
      customPressed: custom?.getAttribute('aria-pressed'),
      nonePressed: cardOf('无')?.getAttribute('aria-pressed'),
      warn: [...(pick('自定义')?.querySelectorAll('span') ?? [])]
        .filter(sp => (sp.textContent ?? '').includes('自动解析为无规范'))
        .map(sp => getComputedStyle(sp).color)[0],
    }
  })
  console.log(`  悬空名状态: ${JSON.stringify(ghost)}`)
  // A stale name and an empty name are ONE state, so they get one wording: the
  // dialog is told the slot is unusable, not that a particular file is gone.
  check('3e-d) 悬空名不显示，改说无可用规范',
    ghost.text === '当前未选择规范，将自动解析为无规范', ghost.text)
  // Amber, and only because 自定义 is highlighted here (asserted below): the line
  // states that the effective spec fell back, which is the same class of message
  // as the Workspace card's "it is gone" line.
  check('3e-d) 该行用警告色', ghost.colour === 'rgb(245, 158, 11)', String(ghost.colour))
  check('3e-d) 悬空名不残留在 title 里', ghost.hasTitle === false)
  // The highlight follows the STORED mode, so a file disappearing must not move
  // it. An earlier version highlighted the resolved spec, which made deleting a
  // file look like it had changed the setting — reported as "删除只是删除，怎么自动
  // 跳到无规范了". The mode moves only when 确认 writes 'none'.
  check('3e-d) 文件消失不移动高亮（仍高亮「自定义」）',
    ghost.customPressed === 'true' && ghost.nonePressed === 'false',
    `custom=${ghost.customPressed} none=${ghost.nonePressed}`)
  // Leave the store clean for the sections that follow.
  await rpc('projectGroups/setDocSpecFileName', { request: { name: '' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'default' } })
  await page.waitForTimeout(1500)

  console.log('')
  console.log('=== 4. 上传一个规范（走 Remote，与对话框同一条路）===')
  const uploaded = await rpc('projectGroups/uploadSpec', {
    request: { name: 'probe-spec.md', content: '# 探针规范\n\n## 现状\n' },
  })
  console.log(`  uploadSpec: ${JSON.stringify(uploaded?.value ?? uploaded)}`)
  check('4) 上传成功', uploaded?.value?.written === true, JSON.stringify(uploaded?.value))
  check('4) 文件真的落在插件目录', storedSpecs().includes('probe-spec.md'), JSON.stringify(storedSpecs()))
  check('4) 返回的列表带上了它', (uploaded?.value?.specs ?? []).includes('probe-spec.md'))

  console.log('')
  console.log('=== 5. 同名上传被拒（不覆盖）===')
  const again = await rpc('projectGroups/uploadSpec', {
    request: { name: 'probe-spec.md', content: '# 改了\n' },
  })
  check('5) 第二次上传被拒', again?.value?.written === false, JSON.stringify(again?.value))
  const onDisk = readFileSync(join(specsDir, 'probe-spec.md'), 'utf8')
  check('5) 原文件内容未被覆盖', onDisk.includes('探针规范'), onDisk.slice(0, 40))

  console.log('')
  console.log('=== 6. 危险文件名被拒 ===')
  for (const bad of ['../escape.md', 'sub/dir.md', 'no-extension', '.hidden.md']) {
    const result = await rpc('projectGroups/uploadSpec', { request: { name: bad, content: 'x' } })
    check(`6) 拒绝 ${JSON.stringify(bad)}`, result?.value?.written !== true, JSON.stringify(result?.value))
  }
  check('6) 没有文件逃出目录', !existsSync(join(dshHome, 'project-groups', 'escape.md')))

  console.log('')
  console.log('=== 7. 删除与"正在使用" ===')
  const used = await rpc('projectGroups/specsUsedBy', { request: { name: 'probe-spec.md' } })
  check('7) 未被使用时列表为空', Array.isArray(used?.value?.titles) && used.value.titles.length === 0,
    JSON.stringify(used?.value))
  // Select it globally, then a project should report as using it.
  await rpc('projectGroups/setDocSpecFileName', { request: { name: 'probe-spec.md' } })
  await rpc('projectGroups/setDocSpecMode', { request: { mode: 'custom' } })
  await rpc('projectGroups/create', { request: { title: '使用者', directories: [] } })
  await page.waitForTimeout(1500)
  const used2 = await rpc('projectGroups/specsUsedBy', { request: { name: 'probe-spec.md' } })
  check('7) 全局选中后至少一个项目在用', (used2?.value?.titles ?? []).length >= 1,
    JSON.stringify(used2?.value))

  const removed = await rpc('projectGroups/deleteSpec', { request: { name: 'probe-spec.md' } })
  check('7) 删除成功', removed?.value?.removed === true, JSON.stringify(removed?.value))
  check('7) 文件已不在磁盘', !storedSpecs().includes('probe-spec.md'), JSON.stringify(storedSpecs()))

  console.log('')
  console.log('=== 8. baseline 携带新字段 ===')
  const baseline = await rpc('projectGroups/baseline', {})
  const value = baseline?.value ?? {}
  check('8) baseline 有 docSpecMode', typeof value.docSpecMode === 'string', String(value.docSpecMode))
  check('8) baseline 有 specs 数组', Array.isArray(value.specs), JSON.stringify(value.specs))
  check('8) baseline 有 perProjectDocSpec', typeof value.perProjectDocSpec === 'boolean',
    String(value.perProjectDocSpec))
} catch (error) {
  console.log(`\n探针中断: ${error instanceof Error ? error.stack : String(error)}`)
  failures.push('probe aborted')
} finally {
  console.log('')
  console.log('=== 结果 ===')
  console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`)
  await browser.close().catch(() => {})
  running.kill()
  process.exit(failures.length === 0 ? 0 : 1)
}
