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

const asarRoot = process.argv[2]
if (asarRoot === undefined) {
  console.error('usage: probe-default-path-derivation.mjs <asarRoot>')
  process.exit(2)
}
const { createRequire } = await import('node:module')
const path = await import('node:path')

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
try {
  const dw = requireFromDsh('@deepseek-ai/dsh-api-workspace-controller/default-workspace')
  console.log(`  ✅ 可导入，导出: ${JSON.stringify(Object.keys(dw))}`)
  console.log(`  DEFAULT_WORKSPACE_DIRECTORY = ${JSON.stringify(dw.DEFAULT_WORKSPACE_DIRECTORY)}`)
} catch (error) {
  console.log(`  ❌ ${String(error.message).split('\n')[0]}`)
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
try {
  const stdout = execFileSync('powershell.exe', officialArgs, { encoding: 'utf8' })
  documents = stdout.replace(/[\r\n]+$/, '')
  console.log(`  ✅ Documents = ${JSON.stringify(documents)}`)
} catch (error) {
  console.log(`  ❌ 命令失败: ${String(error.message).split('\n')[0]}`)
}

console.log('')
console.log('=== 4. 与官方实际使用的路径对照 ===')
if (documents === null) {
  console.log('  无法取出 Documents，无法对照')
} else {
  const derived = path.join(documents, 'deepseek-harness', 'default-workspace')
  console.log(`  自行推导: ${derived}`)
  // The path the running install actually registered, read from a profile's
  // workspace.json — the ground truth this derivation must match.
  const fs = await import('node:fs')
  const profiles = [
    'C:/Users/Think/.dsh/storages/workspace.json',
    'C:/Users/Think/.agent/temp/read2/storages/workspace.json',
  ]
  let seen = null
  for (const file of profiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const defaultId = parsed.global?.defaultWorkspaceId
      const entity = defaultId === undefined ? undefined : parsed.tables?.workspaces?.[defaultId]
      // Fall back to any workspace whose path ends in the default segment.
      const fallback = Object.values(parsed.tables?.workspaces ?? {})
        .find(value => String(value.path).endsWith('deepseek-harness\\default-workspace'))
      seen = entity?.path ?? fallback?.path ?? null
      if (seen !== null) {
        console.log(`  官方注册的: ${seen}   (来自 ${file})`)
        break
      }
    } catch {
      // profile not present; try the next
    }
  }
  console.log('')
  console.log(`  ⇒ 推导是否与官方一致: ${seen !== null && seen === derived ? '✅ 逐字符相同' : seen === null ? '（未找到对照值）' : `❌ 不同（官方 ${seen}）`}`)
}

console.log('')
console.log('=== 5. 结论 ===')
console.log('  若第 1 步全部 ❌ 而第 2、3 步成功，则 Host 半必须【自行拼路径】:')
console.log('    <第 3 步取到的 Documents> + "deepseek-harness" + <第 2 步的常量>')
console.log('  调用方需要一个跨平台分支（darwin 用 osascript，linux 用 xdg-user-dir），')
console.log('  与官方 default-directory.js 的实现逐条对应。')
