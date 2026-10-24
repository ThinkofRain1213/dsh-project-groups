/**
 * 真实 DSH 探针的共同起点：把「profile 可用」和「界面可点」两件事收敛到一处。
 *
 * 这个文件存在的原因是同一类缺口被反复踩到，而且每次都换一个形状出现。
 *
 * ## 缺口一：`dsh plugin --profile <name> add` 建出的 profile 启动后不监听
 *
 * 该命令建的是**用户覆盖层**：`cordis.patch.yml` + `package.json` (+ `pnpm-workspace.yaml`)。
 * 它**不生成 `cordis.yml`**，而 `cordis.yml` 是 profile 的根入口。缺了它，进程会正常存活、
 * **stdout 与 stderr 全空**、端口**从不监听** —— 于是探针在 120 秒后报 `boot timeout`，
 * 而屏幕上没有任何线索指向真正的原因。
 *
 * 实测对照（同一个隔离 `DSH_HOME`）：
 *
 * | profile 来源 | 启动后拿到 URL 的时间 |
 * |---|---|
 * | `plugin --profile pg add …`（缺 `cordis.yml`） | 25 秒内 **从未** 输出 |
 * | 先 `--from-default-profile web` 派生、再 `plugin add` | **第 2 秒** |
 *
 * 所以 `ensureProbeProfile` 的顺序是固定的：**先派生，后装插件**。反过来是错的，
 * 因为 `plugin add` 到一个不存在的 profile 上只会给你一个覆盖层。
 *
 * ## 缺口二：首次启动的登录引导挡住整个侧栏
 *
 * 隔离 profile 没有账号凭据，首启会弹「开始使用 / 登录 DeepSeek 账号」，它是一层
 * 全局遮罩（`div[aria-hidden="true"]` 里带 `mask` 的那个），**拦截所有点击**。
 * 关掉它之后侧栏才可点。
 *
 * 两个已经实测的性质决定了修法：
 *
 * 1. **关闭不写任何持久状态。** 关闭前后 localStorage 逐字节相同，所以**重载、重启都会
 *    重新弹出** —— 只关一次不够，每个页面加载都要关。
 * 2. **只有「关闭」能关掉它。** 探针里原先那六个标签（稍后配置 / 继续 / …）是**别的**
 *    弹窗的文案，对这个引导一个都不匹配。
 *
 * 引导本身的可见性由 Host 的 settings 文档推导（`ui-settings-account` 的 `step` 不是
 * `done` 就显示），所以将来若改为预置该文档，`dismissModals` 会退化成「没有遮罩就立即
 * 返回」的空操作 —— 它不会因为那一天到来而需要改。
 *
 * ## 为什么不放在 `pnpm check` 里
 *
 * 这两件事都需要**本机装有 DSH**（要读 `app.asar` 拿 CLI，要能 spawn Electron）和
 * 一个可用端口。CI 的 runner 两样都没有，所以调用方是手跑的命令，不是门禁。
 *
 * @module dsh-project-groups/scripts/lib/boot-dsh
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactToken } from './redact.mjs'

/**
 * 本仓库的根目录，由本文件位置推出。
 *
 * 探针要把**本仓库**装进 profile，写死一个绝对路径会在别的机器上装进一个不存在的目录，
 * 而 pnpm 只报「Already up to date」—— 于是探针测的是旧产物，输出里没有任何提示。
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 派生 profile 用的模板。`web` 是带浏览器界面的那个，探针全都需要它。 */
export const DEFAULT_TEMPLATE = 'web'

/**
 * 关闭弹窗时要点的按钮文案，按尝试顺序。
 *
 * 分两组，因为它们是**两个不同**的弹窗：
 *
 * - `关闭` / `Close` —— 登录引导（`SignInDialog` 的关闭按钮，aria-label 为 `close`）。
 *   只有它能关掉那个遮罩，所以排在最前。
 * - 其余 —— 官方的一次性公告 / 配置引导。保留原有文案不变，因为已有探针依赖它们。
 */
export const DISMISS_LABELS = [
  '关闭',
  'Close',
  '稍后配置',
  '继续',
  'Continue',
  'Later',
  'Got it',
  '知道了',
  '跳过',
  'Skip',
]

/**
 * `dsh` CLI 的入口路径。
 *
 * 官方把它放在 asar **内部**（`app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`），
 * 而 Electron 能直接从 asar 里加载 JS，所以这个路径可以原样交给 `spawn`；
 * `app.asar.unpacked/` 下**没有**这个文件，按目录直觉去那里找会得到 `MODULE_NOT_FOUND`。
 * @param asarRoot - 安装目录下的 `resources/app.asar` 路径。
 * @returns CLI 入口的绝对路径。
 */
export function dshBinPath(asarRoot) {
  return join(asarRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * 跑一次 CLI 并等它退出。
 *
 * `stdio` 用 `ignore` 收 stdout、`pipe` 收 stderr：这两条命令的输出对调用方**无用**
 * （`--dump-config` 打的是整棵组合树），但失败时的 stderr 有用，所以只留它。
 * stdout 若也 `pipe` 而不读，子进程写满管道缓冲后会阻塞 —— 一条只在慢机器上出现的挂起。
 * @param exe - Electron 可执行文件。
 * @param args - 传给 CLI 的参数。
 * @param options - `dshHome`、`cwd`（可选）。
 * @returns `{ ok, stderr }`。
 */
function runCli(exe, args, { dshHome, cwd }) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, args, {
      cwd: cwd ?? REPO_ROOT,
      env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    // 没有 `error` 监听时，一次失败的 spawn 会**以未捕获事件让整个进程崩掉**，
    // 而且不写 stdout —— 调用方看到的会是「什么都没发生」。
    child.on('error', (error) => resolvePromise({ ok: false, stderr: `spawn failed: ${error.message}` }))
    child.on('exit', (code) => resolvePromise({ ok: code === 0, stderr }))
  })
}

/**
 * 确保探针要用的 profile 存在、可启动，并且装好了本仓库的插件。
 *
 * **幂等**：`cordis.yml` 已经在就跳过派生这一步。但**不跳过** `plugin add`，
 * 因为本仓库是 `link:` 安装的，插件版本与产物会变，重新 `add` 一次是幂等的
 * （pnpm 报 `Already up to date`），而跳过它会让探针测到上一次装的旧产物。
 *
 * @param options - 见下。
 * @param options.exe - Electron 可执行文件路径。
 * @param options.asarRoot - 安装目录下的 `resources/app.asar`。
 * @param options.dshHome - 隔离的 `DSH_HOME`，用完可整目录删除。
 * @param options.profile - profile 名，默认 `pg`。
 * @param options.template - 派生用的模板，默认 `web`。
 * @param options.installPlugin - 是否把本仓库装进该 profile。
 *   官方向照（`official` profile）传 `false` —— 它要的是**没有**本插件的侧栏。
 * @param options.log - 可选的进度输出函数，默认 `console.log`。
 * @returns `{ created, installed, problem }`；`problem` 有值即失败，调用方应据此中止。
 */
export async function ensureProbeProfile({
  exe,
  asarRoot,
  dshHome,
  profile = 'pg',
  template = DEFAULT_TEMPLATE,
  installPlugin = true,
  log = console.log,
}) {
  const bin = dshBinPath(asarRoot)
  const profileDir = join(dshHome, 'profiles', profile)
  const marker = join(profileDir, 'cordis.yml')
  const created = !existsSync(marker)

  if (created) {
    // `--dump-config` 让 CLI 走完整个组装、打印、退出 —— 派生 profile 的副作用就在这一步。
    // 不实际启动，所以既快又不会占端口。
    const derived = await runCli(exe, [bin, '--profile', profile, '--from-default-profile', template, '--dump-config'], { dshHome })
    if (!derived.ok) {
      return { created, installed: false, problem: `派生 profile "${profile}" 失败：${redactToken(derived.stderr.slice(-600))}` }
    }
    if (!existsSync(marker)) {
      return { created, installed: false, problem: `派生 profile "${profile}" 后 ${marker} 仍不存在 —— 这是 profile 自举的硬前提` }
    }
    log(`  (已派生 profile "${profile}"，模板 ${template})`)
  }

  if (installPlugin) {
    const added = await runCli(exe, [bin, 'plugin', '--profile', profile, 'add', REPO_ROOT], { dshHome })
    if (!added.ok) {
      return { created, installed: false, problem: `把本仓库装进 profile "${profile}" 失败：${redactToken(added.stderr.slice(-600))}` }
    }
  }

  return { created, installed: installPlugin, problem: undefined }
}

/**
 * 读一个已存在 profile 的 `package.json`，供调用方断言实际装了什么。
 *
 * 存在的意义是**取证**：探针跑出失败时，第一个要排除的就是「测的是别的产物」。
 * @param dshHome - 隔离的 `DSH_HOME`。
 * @param profile - profile 名。
 * @returns 解析后的对象，读不到时为 `undefined`。
 */
export function readProfileManifest(dshHome, profile = 'pg') {
  const path = join(dshHome, 'profiles', profile, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 当前有没有遮罩挡住点击。
 * @param page - Playwright 的 page。
 * @returns 是否被遮罩。
 */
export function isMasked(page) {
  return page.evaluate(() => [...document.querySelectorAll('div[aria-hidden="true"]')]
    .some(node => node.className.includes('mask')))
}

/**
 * 关掉当前挡路的弹窗，直到没有遮罩或者再也点不动。
 *
 * 调用点应当放在**每次 `page.goto` / `reload` 之后**：见模块头注释，登录引导的关闭不持久。
 * 没有遮罩时它立即返回，所以放在多次导航之间重复调用是安全的。
 *
 * @param page - Playwright 的 page。
 * @param options - `attempts`（默认 8）、`settleMs`（默认 1200）、`finalWaitMs`（默认 800）。
 * @returns `{ masked, clicked }` —— `masked` 为真表示还有遮罩，调用方应据此报失败而不是继续点击。
 */
export async function dismissModals(page, { attempts = 8, settleMs = 1200, finalWaitMs = 800 } = {}) {
  let clicked = []
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!await isMasked(page)) return { masked: false, clicked }
    clicked = []
    for (const label of DISMISS_LABELS) {
      const button = page.getByRole('button', { name: label, exact: true }).first()
      if (await button.count() === 0) continue
      // 失败要**记下来**而不是吞掉：点不动就是遮罩还在，而后续每一次点击都会超时在
      // 一个与真实原因无关的地方。返回值的 `clicked` 让调用方能说出点过什么。
      const ok = await button.click({ force: true }).then(() => true).catch(() => false)
      clicked.push(ok ? label : `${label}(失败)`)
      if (ok) await page.waitForTimeout(settleMs)
    }
    await page.waitForTimeout(finalWaitMs)
  }
  return { masked: await isMasked(page), clicked }
}

/**
 * 等页面进入「侧栏可点」的状态，供探针在做任何点击之前调用。
 *
 * 先等一次遮罩消失（登录引导要等客户端 bundle 挂载后才会渲染出来），再关。
 * 超时不抛错 —— 抛错会变成一条 `TimeoutError` 堆栈，而这里要的是一条能读的失败行。
 *
 * @param page - Playwright 的 page。
 * @param options - `timeoutMs`（默认 20000）、`log`。
 * @returns 同 {@link dismissModals}。
 */
export async function settleOnboarding(page, { timeoutMs = 20_000, log = console.log } = {}) {
  // 登录引导依赖客户端 bundle 挂载，而 `networkidle` 只说明网络静了。
  // 给一个有时限的等待，然后无论结果如何都往下走：真要关不掉，下面会如实报告。
  await page.waitForFunction(
    () => ![...document.querySelectorAll('div[aria-hidden="true"]')].some(node => node.className.includes('mask')),
    null,
    { timeout: timeoutMs },
  ).catch(() => {})
  const result = await dismissModals(page)
  if (result.masked) log(`  ⚠ 仍有遮罩挡住点击（已尝试：${result.clicked.join('、') || '无匹配按钮'}）`)
  return result
}
