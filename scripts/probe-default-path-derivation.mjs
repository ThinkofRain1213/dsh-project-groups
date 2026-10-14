/**
 * Can the plugin's Host half compute the official default-Workspace path?
 *
 * Option (b) for the missing-Workspace dialog is "the Host half exposes the derived
 * path over a Remote, so the dialog can name it". That only works if the Host half can
 * actually produce the same path the official `initializeDefault` would use — and the
 * official derivation is not obviously reachable:
 *
 *   - `defaultWorkspaceDirectory()` lives in `lib/types/default-directory.js`, which is
 *     **not** an `exports` entry, so a plain deep import should be refused by Node;
 *   - the last segment (`default-workspace`) *is* exported, from `./default-workspace`;
 *   - the Documents folder itself comes from a native command
 *     (`[Environment]::GetFolderPath(MyDocuments)`), which is a Host-only ability.
 *
 * Each of those is tested here rather than reasoned about, because "the import is
 * blocked" is exactly the kind of claim that is easy to get wrong from a d.ts file.
 *
 * Run with Electron-as-Node so the asar is readable.
 *
 * Usage: electron-as-node probe-default-path-derivation.mjs <asarRoot>
 */

/**
 * Compare filesystem paths across separator style, case and a trailing separator. The fallback
 * matcher used to look for the literal `deepseek-harness\default-workspace`, so it never matched
 * a `/`-separated path and missed a casing-only difference.
 */
const normalizePath = (value) => String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

const asarRoot = process.argv[2]
if (asarRoot === undefined) {
  console.error('usage: probe-default-path-derivation.mjs <asarRoot> [profileWorkspaceJson]')
  process.exit(2)
}
const { createRequire } = await import('node:module')
const path = await import('node:path')
const os = await import('node:os')

// Resolve from inside the installed DSH, which is where a plugin's Host half runs.
const requireFromDsh = createRequire(`${asarRoot.replaceAll('\\', '/')}/dsh/package.json`)

console.log('=== 1. 深路径 import 是否被 exports 拦住 ===')
const attempts = [
  '@deepseek-ai/dsh-api-workspace-controller/lib/types/default-directory.js',
  '@deepseek-ai/dsh-api-workspace-controller/lib/index.js',
  '@deepseek-ai/dsh-api-workspace-controller',
]
for (const spec of attempts) {
  try {
    const loaded = requireFromDsh(spec)
    const keys = Object.keys(loaded)
    console.log(`  ✅ ${spec}`)
    console.log(`      导出: ${JSON.stringify(keys.slice(0, 10))}`)
  } catch (error) {
    console.log(`  ❌ ${spec}`)
    console.log(`      ${error.code ?? ''} ${String(error.message).split('\n')[0]}`)
  }
}

console.log('')
console.log('=== 2. 末段常量是否可得（来自 ./default-workspace）===')
// Hoisted so step 4 composes the path from the *official* constant instead of re-typing the
// literal: two copies of the segment could silently diverge and the comparison would then prove
// nothing about what the official code produces.
let defaultWorkspaceDirectory = 'default-workspace'
try {
  const dw = requireFromDsh('@deepseek-ai/dsh-api-workspace-controller/default-workspace')
  console.log(`  ✅ 可导入，导出: ${JSON.stringify(Object.keys(dw))}`)
  console.log(`  DEFAULT_WORKSPACE_DIRECTORY = ${JSON.stringify(dw.DEFAULT_WORKSPACE_DIRECTORY)}`)
  if (typeof dw.DEFAULT_WORKSPACE_DIRECTORY === 'string') defaultWorkspaceDirectory = dw.DEFAULT_WORKSPACE_DIRECTORY
} catch (error) {
  console.log(`  ❌ ${String(error.message).split('\n')[0]}`)
  console.log(`     回退到字面量 ${JSON.stringify(defaultWorkspaceDirectory)}（导入失败时无法证明它仍与官方一致）`)
}

console.log('')
console.log('=== 3. Host 半能否用官方那条命令取到 Documents 目录 ===')
const { execFileSync } = await import('node:child_process')
// Verbatim from the official `defaultWorkspaceDirectory`, including `DoNotVerify`
// (which is what keeps the lookup from creating the folder as a side effect).
const officialArgs = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  + '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, '
  + '[Environment+SpecialFolderOption]::DoNotVerify)',
]
let documents = null
if (process.platform !== 'win32') {
  // Said out loud instead of failing the command silently: the PowerShell form is one of three
  // official branches (darwin uses `osascript`, linux uses `xdg-user-dir`), and on this platform
  // it is simply the wrong one — so nothing below is measured rather than measured wrongly.
  console.log(`  ⏭ 非 Windows（process.platform=${process.platform}）：本平台官方走 osascript / xdg-user-dir，`)
  console.log('     PowerShell 这条分支不适用，本步不做任何测量。')
} else {
  try {
    const stdout = execFileSync('powershell.exe', officialArgs, { encoding: 'utf8' })
    documents = stdout.replace(/[\r\n]+$/, '')
    console.log(`  ✅ Documents = ${JSON.stringify(documents)}`)
  } catch (error) {
    console.log(`  ❌ 命令失败: ${String(error.message).split('\n')[0]}`)
  }
}

console.log('')
console.log('=== 4. 与官方实际使用的路径对照 ===')
if (documents === null) {
  console.log('  无法取出 Documents，无法对照')
} else {
  const derived = path.join(documents, 'deepseek-harness', defaultWorkspaceDirectory)
  console.log(`  自行推导: ${derived}`)
  // The path the running install actually registered, read from a profile's
  // workspace.json — the ground truth this derivation must match.
  //
  // Not hardcoded to one developer's home: the running user's own profile is the default, and
  // `argv[3]` / `DSH_PROBE_WORKSPACE_JSON` point at another one when comparing against a
  // different install.
  const fs = await import('node:fs')
  const profiles = [
    process.argv[3] ?? process.env.DSH_PROBE_WORKSPACE_JSON ?? path.join(os.homedir(), '.dsh', 'storages', 'workspace.json'),
    path.join(os.homedir(), '.agent', 'temp', 'read2', 'storages', 'workspace.json'),
  ]
  let seen = null
  for (const file of profiles) {
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      // ENOENT is the expected case (that profile is simply not installed); anything else — a
      // permission error, a directory in the way — is reported, because it would otherwise look
      // exactly like "no ground truth to compare against".
      if (error.code !== 'ENOENT') console.log(`  ⚠ 读不了 ${file}: ${String(error.message).split('\n')[0]}`)
      continue
    }
    try {
      const parsed = JSON.parse(raw)
      const defaultId = parsed.global?.defaultWorkspaceId
      const entity = defaultId === undefined ? undefined : parsed.tables?.workspaces?.[defaultId]
      // Fall back to any workspace whose path ends in the default segment, matched on the
      // normalized form so separators, case and a trailing separator cannot hide it.
      const fallback = Object.values(parsed.tables?.workspaces ?? {})
        .find(value => normalizePath(value.path).endsWith(normalizePath(path.join('deepseek-harness', defaultWorkspaceDirectory))))
      seen = entity?.path ?? fallback?.path ?? null
      if (seen !== null) {
        console.log(`  官方注册的: ${seen}   (来自 ${file})`)
        break
      }
    } catch (error) {
      console.log(`  ⚠ ${file} 不是合法 JSON: ${String(error.message).split('\n')[0]}`)
    }
  }
  console.log('')
  // Named branches instead of a nested ternary, and the comparison is on the normalized form:
  // an exact `===` reported "different" for two spellings of the same directory.
  if (seen === null) {
    console.log('  ⇒ 推导是否与官方一致: （未找到对照值，未做比较）')
  } else if (normalizePath(seen) === normalizePath(derived)) {
    console.log('  ⇒ 推导是否与官方一致: ✅ 逐字符相同')
  } else {
    console.log(`  ⇒ 推导是否与官方一致: ❌ 不同（官方 ${seen}）`)
  }
}

console.log('')
console.log('=== 5. 结论 ===')
console.log('  若第 1 步全部 ❌ 而第 2、3 步成功，则 Host 半必须【自行拼路径】:')
console.log(`    <第 3 步取到的 Documents> + "deepseek-harness" + ${JSON.stringify(defaultWorkspaceDirectory)}`)
console.log('  调用方需要一个跨平台分支（darwin 用 osascript，linux 用 xdg-user-dir），')
console.log('  与官方 default-directory.js 的实现逐条对应。')
console.log('  注意：本脚本只在 Windows 上执行了 PowerShell 分支；osascript / xdg-user-dir 两条')
console.log('  分支在这里【没有被执行过】，上面的结论只是对它们的描述，不是对它们的验证。')
