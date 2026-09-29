/**
 * The official default Workspace's directory, derived on the Host.
 *
 * ## Why this exists
 *
 * The missing-底层工作区 dialog names the path that is gone, and only the Host can
 * produce it: the path starts at the OS Documents folder, which a browser cannot read.
 * `initializeDefault` is not a substitute — it returns `undefined` once its recorded
 * `defaultWorkspaceId` dangles (measured), and it is a *write* path besides.
 *
 * ## Why it is reimplemented rather than imported
 *
 * The official derivation is `defaultWorkspaceDirectory` in
 * `@deepseek-ai/dsh-api-workspace-controller/lib/types/default-directory.js`, and that
 * subpath is **not** in the package's `exports` map — importing it fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` (measured against the installed asar). So the three
 * parts are reassembled here:
 *
 *   1. the leaf name, imported from the **exported** `./default-workspace` entry, so it
 *      stays in step with the title the registry derives from it;
 *   2. the Documents folder, from the same native query the official code runs;
 *   3. the `deepseek-harness` intermediate segment.
 *
 * The validation is copied too, including the Windows-specific root check: a failed
 * `[Environment]::GetFolderPath` returns `\`, and joining that would silently produce
 * `\deepseek-harness\default-workspace` — a path that is absolute yet meaningless.
 *
 * ## Cost control
 *
 * The Documents query spawns a child process, so it is bounded by a timeout and any
 * failure yields `null` rather than throwing: this runs to *label* a dialog, and a
 * dialog that fails to open because it could not name the path would be worse than one
 * that says the path is unknown.
 */
import { execFile } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { DEFAULT_WORKSPACE_DIRECTORY } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'

/**
 * How long the Documents lookup may take before it is abandoned.
 *
 * The official deployment keeps its own bound (`documentsLookupTimeoutMs`). Spawning
 * `powershell.exe` on a cold, loaded machine is the slow case; three seconds is
 * generous for a query that reads one environment value, and the fallback (`null`) is
 * a readable dialog rather than a hang.
 */
const LOOKUP_TIMEOUT_MS = 3000

/**
 * Run one native command and return its stdout, or `null` when it fails or times out.
 * @param file - executable to run.
 * @param args - its arguments.
 * @returns stdout with the trailing newline removed, or `null`.
 */
async function stdoutOf(file: string, args: readonly string[]): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        // A missing command, a non-zero exit, and a timeout are one case here: the
        // caller has a `null` answer for all three.
        if (error !== null) {
          resolve(null)
          return
        }
        resolve(stdout.replace(/[\r\n]+$/, ''))
      },
    )
  })
}

/**
 * Ask the OS for the account's Documents folder.
 *
 * The commands are the official ones, verbatim, including the flags that matter:
 * `-NoProfile -NonInteractive` so a user profile script cannot change the answer, and
 * `DoNotVerify` so the query itself does not **create** the Documents folder — the
 * official code documents the same reason ("without creating files").
 * @param platform - the host platform.
 * @returns the raw spelling, or `null` when unavailable.
 */
async function documentsDirectoryOf(platform: NodeJS.Platform): Promise<string | null> {
  switch (platform) {
    case 'win32':
      return await stdoutOf('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
        + '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, '
        + '[Environment+SpecialFolderOption]::DoNotVerify)',
      ])
    case 'darwin':
      return await stdoutOf('osascript', [
        '-e',
        'POSIX path of (path to documents folder from user domain without folder creation)',
      ])
    case 'linux':
      return await stdoutOf('xdg-user-dir', ['DOCUMENTS'])
    default:
      return null
  }
}

/**
 * The directory the official default Workspace occupies on this Host.
 *
 * Pure read: nothing is created, moved, or registered. The answer is derived on every
 * call rather than cached, matching the navigation policy that resolves per click —
 * a cached path would outlive the OS setting it came from.
 * @param platform - the host platform; injectable for tests.
 * @returns the absolute path, or `null` when the Documents folder is unavailable.
 */
export async function defaultWorkspacePath(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const documents = await documentsDirectoryOf(platform)
  if (documents === null) return null

  // The official validation, copied: absolute, and on Windows a root of `\` or `/`
  // means the lookup failed and returned a bare separator.
  const paths = platform === 'win32' ? win32 : posix
  if (documents === '' || !paths.isAbsolute(documents)) return null
  if (platform === 'win32') {
    const root = paths.parse(documents).root
    if (root === '\\' || root === '/') return null
  }

  return paths.join(paths.normalize(documents), 'deepseek-harness', DEFAULT_WORKSPACE_DIRECTORY)
}
