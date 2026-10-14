/**
 * Where the work-document feature keeps its files, and how a spec is identified.
 *
 * ## Two roots, both resolved at run time
 *
 * Nothing here is a literal absolute path, because the plugin ships to other
 * machines:
 *
 *  - the **document** and every **uploaded spec** live under `$DSH_HOME`, whose
 *    resolution order copies the official one (`profileContext.home` first, then
 *    `$DSH_HOME`, then `~/.dsh` — the order `dsh-home-paths` documents and the
 *    peer plugin `dsh-codearts-auth` also uses);
 *  - the **built-in spec** is resolved from this module's own URL, so both a
 *    `link:` install (this checkout) and a `git`/registry install (under
 *    `node_modules`) find it. `@deepseek-ai/dsh-skill-office` locates its assets
 *    the same way.
 *
 * ## Why a content hash identifies a spec
 *
 * The drift check asks "is the document aligned with the spec now configured?".
 * Comparing file names would answer a different question: overwriting an
 * uploaded spec under the same name, or a plugin upgrade rewriting the built-in
 * one, both leave the name identical while changing what the document should
 * follow. A SHA-1 of the content detects both. The algorithm matches the
 * official `instructionContentSha1` in `@deepseek-ai/dsh-agent-instructions`,
 * which solves the same "has this content changed" problem for instruction
 * files; this is content identity, not a security boundary.
 *
 * @module dsh-project-groups/src/spec-store
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { DocSpecMode } from './spec.ts'

/** Directory under the Harness home holding this feature's document + specs. */
const FEATURE_DIR = 'project-groups'

/** Uploaded specs live in this subdirectory, one file each. */
const SPECS_DIR = 'specs'

/** Extension every spec must carry, for both upload and listing. */
export const SPEC_EXTENSION = '.md'

/**
 * The built-in spec, resolved against this module rather than a configured root.
 *
 * `../spec/...` because this file compiles to `lib/index.js` while the spec
 * ships at the package root.
 */
export const BUILT_IN_SPEC_PATH: string = fileURLToPath(new URL('../spec/PROJECT-SPEC.md', import.meta.url))

/** The rewrite procedure the drift prompt points the model at. */
export const REWRITE_FLOW_PATH: string = fileURLToPath(new URL('../spec/REWRITE-FLOW.md', import.meta.url))

/**
 * Resolve the Harness home, most specific source first.
 *
 * `profileContext.home` is the launcher's own answer and outranks the
 * environment; the environment outranks the OS home; a blank `$DSH_HOME` is
 * treated as unset rather than resolving to the current directory, matching the
 * official resolver.
 * @param ctx - Host context, for the optional launcher-provided profile.
 * @returns the absolute Harness home.
 */
export function harnessHome(ctx: Context): string {
  const profile = ctx.get('profileContext') as { readonly home?: string } | undefined
  if (profile?.home !== undefined && profile.home.length > 0) return profile.home
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** @returns the directory holding uploaded specs (not created here). */
export function specsDirectory(ctx: Context): string {
  return join(harnessHome(ctx), FEATURE_DIR, SPECS_DIR)
}

/**
 * @param ctx - Host context.
 * @param projectId - owning project.
 * @returns the absolute path of that project's document, or undefined when the id
 * is not a usable path segment. Returned rather than thrown: this runs while
 * assembling an injection, and a corrupt record must drop the document half
 * instead of failing the request.
 */
export function documentPath(ctx: Context, projectId: string): string | undefined {
  if (!isSafePathSegment(projectId)) return undefined
  return join(harnessHome(ctx), FEATURE_DIR, `${projectId}${SPEC_EXTENSION}`)
}

/**
 * Whether an id is safe as a single path segment.
 *
 * The same boundary {@link isSafeSpecName} draws for uploaded specs, applied to a
 * value that reaches a path builder from somewhere else. `projectId` is generated
 * as a UUID, but it is read back from a stored domain record, and the domain
 * parses `projects` keys as plain strings — so a record edited on disk (or a
 * future caller passing a user-influenced id) could carry `..`, a separator, or a
 * control character and resolve outside `$DSH_HOME/project-groups`.
 *
 * Unreachable through this plugin's own writes today; checked anyway, because the
 * two path builders should enforce one rule rather than one enforcing it and the
 * other trusting its input.
 * @param id - candidate path segment.
 * @returns true when the id may be joined onto the feature directory.
 */
export function isSafePathSegment(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false
  if (id.includes('/') || id.includes('\\')) return false
  // A bare `.`/`..` is a directory reference, not an id; a leading dot would also
  // hide the document from a listing.
  if (id.startsWith('.')) return false
  /* eslint-disable-next-line no-control-regex -- rejecting control characters is the point */
  if (/[\u0000-\u001f]/.test(id)) return false
  return true
}

/** @returns the absolute path of one uploaded spec, or undefined for a bad name. */
export function uploadedSpecPath(ctx: Context, fileName: string): string | undefined {
  if (!isSafeSpecName(fileName)) return undefined
  return join(specsDirectory(ctx), fileName)
}

/**
 * Windows reserved device names, without extension.
 *
 * Opening `CON.md`, `NUL.md`, `AUX.md`, `COM1.md`, … on Windows does not create a
 * regular file: the name resolves to the device no matter what follows the dot. A spec
 * by that name would be silently unwritable (writes go nowhere, or fail) rather than
 * stored, so the name is refused up front.
 */
const WINDOWS_RESERVED_BASE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * Whether a name is a bare, single-segment spec file name.
 *
 * The check is what keeps an upload or a delete from addressing anything outside
 * the specs directory: a name carrying a separator, a drive, or a parent hop
 * would let a Remote caller write wherever it liked.
 *
 * ## Why filesystem normalization is checked too
 *
 * A separator check alone is not enough, because some names are distinct as strings
 * yet resolve to something that is not the intended file. Reserved device names
 * (`CON.md`, `NUL.md`, `AUX.md`, `COM1.md`, …) are the real case: on Windows the name
 * resolves to the device no matter what follows the dot, so a spec by that name is
 * silently unwritable rather than stored.
 *
 * The Windows "trailing dot or space is stripped" hazard needs no check of its own,
 * because it cannot arise here: any such name fails the `endsWith('.md')` test above
 * (`a.md.` and `a.md ` both end in a dot/space, not in `.md`). An earlier draft of this
 * guard tested the stem for a trailing dot and rejected `a..md`, which is a legitimate,
 * distinct name — the interior dot is not stripped by Windows. The extension check is
 * what covers that case, and it covers it without the false rejection.
 *
 * Case and Unicode folding (`Ａ.md` vs `A.md` on a case-insensitive filesystem) is
 * likewise **not** rejected: refusing it would break legitimate names on
 * case-sensitive filesystems, and the collision it can cause is caught by the
 * exists-check at write time rather than being a path-safety hole.
 * @param name - candidate file name.
 * @returns true when the name may be joined onto the specs directory.
 */
export function isSafeSpecName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false
  if (!name.endsWith(SPEC_EXTENSION)) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  // A leading dot would hide the file from a listing; a bare `..`/`.` is not a name.
  if (name.startsWith('.')) return false
  /* eslint-disable-next-line no-control-regex -- rejecting control characters is the point */
  if (/[\u0000-\u001f]/.test(name)) return false
  // Strip the extension, then reject a base that names a device. The base cannot end in
  // a dot or space: such a name would not have passed the `endsWith('.md')` test above,
  // so no separate check is needed — see the doc comment.
  const base = name.slice(0, -SPEC_EXTENSION.length)
  if (base.length === 0) return false
  if (WINDOWS_RESERVED_BASE.test(base)) return false
  return true
}

/** One file's identity, cheap enough to recompute only when the file changes. */
interface HashMemo {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
  readonly sha1: string
}

/** Last hash per path; the file's mtime+size is the invalidation key. */
const hashes = new Map<string, HashMemo>()

/**
 * How many paths the hash memo keeps.
 *
 * Generous — the steady-state working set is a handful of files — but finite, because the key
 * space is not: a project's document path embeds its id, so every create/delete cycle adds a
 * key that will never be read again. See {@link specSha1}.
 */
const HASH_MEMO_LIMIT = 256

/**
 * SHA-1 of one file's content, memoized on path + mtime + size.
 *
 * Synchronous because the caller is `PromptContext.text`, which the official
 * registry evaluates synchronously per assembly. A stat is microseconds and the
 * read only happens when the file actually changed, so a steady state costs one
 * `statSync` per injected request.
 * @param path - absolute file path.
 * @returns the lowercase hex digest, or undefined when the file is absent.
 */
export function specSha1(path: string): string | undefined {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(path)
  } catch {
    // Absent (or unreadable) is "no spec content", which callers render as none.
    hashes.delete(path)
    return undefined
  }
  const memo = hashes.get(path)
  if (memo !== undefined && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.sha1
  try {
    const sha1 = createHash('sha1').update(readFileSync(path)).digest('hex')
    // Only memoized when the file did not change between the stat and the read.
    //
    // The two are separate syscalls, so a writer landing in between makes the digest describe
    // the **new** bytes while `mtimeMs`/`size` describe the old ones. Caching that pairing
    // meant the drift check treated a changed spec as unchanged until the mtime ticked again —
    // silently, and for exactly the case the memo exists to serve. Re-statting and comparing
    // is what makes the entry a statement about one consistent observation. The digest is
    // returned either way: it is the content that was actually read, so it is the best answer
    // available even when the file moved under us.
    const after = statSync(path)
    if (after.mtimeMs === stat.mtimeMs && after.size === stat.size) {
      hashes.set(path, { path, mtimeMs: stat.mtimeMs, size: stat.size, sha1 })
      // Bounded, because the key space grows with project count: a document path is derived
      // from a project id, so create/delete cycles mint new keys whose entries are never read
      // again. A Map iterates in insertion order, so dropping the oldest keeps this a cache
      // rather than a slow leak — and a dropped entry only costs one stat+read to rebuild.
      while (hashes.size > HASH_MEMO_LIMIT) {
        const oldest = hashes.keys().next()
        if (oldest.done === true) break
        hashes.delete(oldest.value)
      }
    } else {
      hashes.delete(path)
    }
    return sha1
  } catch {
    hashes.delete(path)
    return undefined
  }
}

/** Which spec applies to one project, as the settings surface resolves it. */
export interface ResolvedSpec {
  readonly mode: DocSpecMode
  /** Absolute path of the effective spec file, absent for `'none'` or an unset custom name. */
  readonly path?: string
  /** The uploaded file name, for display and for the "in use" check. Absent unless custom. */
  readonly fileName?: string
}

/**
 * Resolve the effective spec for one project.
 *
 * A project override wins over the global choice, and an override that names a
 * file the user has since deleted falls back to the global choice rather than
 * to "none": the override is stale, not a decision to drop the format.
 * @param ctx - Host context.
 * @param global - the stored global settings.
 * @param project - the project's override, when it has one.
 * @returns the effective mode and, when it names a file, that file.
 */
export function resolveSpec(
  ctx: Context,
  global: { readonly docSpecMode: DocSpecMode; readonly docSpecFileName: string },
  project?: { readonly docSpec?: DocSpecMode | string | undefined } | undefined,
): ResolvedSpec {
  const override = project?.docSpec
  if (override !== undefined) {
    if (override === 'none') return { mode: 'none' }
    // The built-in spec, named explicitly by the project. Without this branch the
    // value fell through to `uploadedSpecPath`, which rejected it for not ending
    // in `.md`, and the project silently followed the GLOBAL choice instead — the
    // opposite of what its own dialog showed.
    if (override === 'default') return { mode: 'default', path: BUILT_IN_SPEC_PATH }
    const path = uploadedSpecPath(ctx, override)
    // A missing file is a stale override; fall through to the global choice.
    if (path !== undefined && existsSync(path)) return { mode: 'custom', path, fileName: override }
  }
  if (global.docSpecMode === 'none') return { mode: 'none' }
  if (global.docSpecMode === 'default') return { mode: 'default', path: BUILT_IN_SPEC_PATH }
  const path = uploadedSpecPath(ctx, global.docSpecFileName)
  if (path === undefined || !existsSync(path)) {
    // 'custom' with nothing chosen yet: no spec to follow, which the injection
    // states outright rather than silently substituting the built-in one.
    return { mode: 'none' }
  }
  return { mode: 'custom', path, fileName: global.docSpecFileName }
}

/** The spec state a call needs to compare the document against. */
export interface SpecIdentity {
  readonly mode: DocSpecMode
  readonly path?: string
  readonly sha1?: string
}

/**
 * Snapshot the effective spec and its content hash.
 * @param ctx - Host context.
 * @param global - the stored global settings.
 * @param project - the project's override, when it has one.
 * @returns the identity the drift check compares against the document's.
 */
export function specIdentity(
  ctx: Context,
  global: { readonly docSpecMode: DocSpecMode; readonly docSpecFileName: string },
  project?: { readonly docSpec?: DocSpecMode | string | undefined } | undefined,
): SpecIdentity {
  const spec = resolveSpec(ctx, global, project)
  if (spec.path === undefined) return { mode: spec.mode }
  return { mode: spec.mode, path: spec.path, sha1: specSha1(spec.path) }
}

/**
 * Every uploaded spec's file name, sorted for a stable display order.
 * @param ctx - Host context.
 * @returns the names; empty when the directory does not exist yet.
 */
export async function listUploadedSpecs(ctx: Context): Promise<string[]> {
  try {
    const names = await readdir(specsDirectory(ctx))
    return names.filter(isSafeSpecName).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * Write one uploaded spec, refusing to replace an existing name.
 *
 * Refusing rather than overwriting is the settings surface's rule: a spec the
 * user may have hand-edited must not be destroyed by a second upload of the same
 * name, and the surface reports "already exists" so the user can rename instead.
 * @param ctx - Host context.
 * @param name - bare `*.md` file name.
 * @param content - the file's text.
 * @returns whether the write landed; false when the name is unsafe or taken.
 */
export async function writeUploadedSpec(ctx: Context, name: string, content: string): Promise<boolean> {
  const path = uploadedSpecPath(ctx, name)
  if (path === undefined) return false
  await mkdir(specsDirectory(ctx), { recursive: true })
  try {
    // `flag: 'wx'` — exclusive create — rather than `existsSync` followed by `writeFile`.
    //
    // The check-then-write pair is a TOCTOU: two concurrent uploads of the same name could
    // both observe "absent" and the second would then **overwrite** the first, destroying a
    // spec the user may have hand-edited — precisely what the contract above says must not
    // happen. `wx` makes "create only if absent" one atomic operation, so the loser gets
    // `EEXIST` and the "name is taken" answer the caller already handles.
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error: unknown) {
    // Only a taken name is a `false`; anything else (a full disk, a permissions problem) is a
    // real failure and propagates, as it did before.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * Read one uploaded spec's text, for the surface's preview.
 * @param ctx - Host context.
 * @param name - bare `*.md` file name.
 * @returns the text, or undefined when absent.
 */
export async function readUploadedSpec(ctx: Context, name: string): Promise<string | undefined> {
  const path = uploadedSpecPath(ctx, name)
  if (path === undefined) return undefined
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Delete one uploaded spec.
 *
 * The caller owns the confirmation: a spec may be referenced by projects, and
 * only the surface knows how to say so.
 * @param ctx - Host context.
 * @param name - bare `*.md` file name.
 * @returns whether a file was removed.
 */
export async function deleteUploadedSpec(ctx: Context, name: string): Promise<boolean> {
  const path = uploadedSpecPath(ctx, name)
  if (path === undefined) return false
  try {
    await rm(path)
    return true
  } catch {
    return false
  }
}
