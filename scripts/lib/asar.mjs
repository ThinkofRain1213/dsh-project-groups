/**
 * Minimal Electron `app.asar` reader.
 *
 * Used by `verify-bundle.mjs` to compare our vendored build against the
 * official bundle shipped in the installed DSH, so the comparison runs against
 * the real artifact rather than a checked-in copy.
 *
 * The format: an 8-byte pickle header (two little-endian uint32s, the second
 * being the JSON header length), then the JSON directory tree, then file data
 * at `8 + headerLength + offset`. The header's trailing pickle padding is not
 * part of the JSON, so the text is trimmed to the last `}`.
 */
import { openSync, readSync, closeSync, existsSync, fstatSync } from 'node:fs'

/**
 * Locate the installed DSH `app.asar`, if this machine has one.
 *
 * Resolved from the environment rather than a literal path: `C:/Users/<name>/...`
 * is only right on the machine that wrote it, and it puts a real username in the
 * repository. `LOCALAPPDATA` is where the installer places a per-user install on
 * Windows; the `Program Files` entry covers a machine-wide one. A caller that
 * knows the path can still pass it explicitly.
 * @returns the absolute path, or undefined when no install is present.
 */
export function findInstalledAsar() {
  const local = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? 'C:/Program Files'
  const candidates = [
    local === '' ? '' : `${local}/Programs/DeepSeek Harness/resources/app.asar`,
    `${programFiles}/DeepSeek Harness/resources/app.asar`,
  ]
  return candidates.find(candidate => candidate !== '' && existsSync(candidate))
}

/** Open an asar and return its header, the data-section base offset, and the file size. */
function readHeader(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const fileSize = fstatSync(fd).size
    const sizeBuf = Buffer.alloc(8)
    if (fileSize < 8 || readSync(fd, sizeBuf, 0, 8, 0) !== 8) {
      throw new Error(`asar: ${asarPath} is too short to hold an 8-byte header (${fileSize} bytes)`)
    }
    const headerLength = sizeBuf.readUInt32LE(4)
    // The length comes from the file itself, so it is checked against the file rather than
    // trusted. Without this a corrupt or hostile value drives `Buffer.alloc` — up to ~4 GB —
    // and a truncated header read would hand `JSON.parse` a zero-padded buffer, failing with a
    // syntax error that says nothing about the actual problem.
    if (headerLength < 2 || 8 + headerLength > fileSize) {
      throw new Error(
        `asar: ${asarPath} declares a ${headerLength}-byte JSON header, `
        + `which does not fit in its ${fileSize} bytes`,
      )
    }
    const headerBuf = Buffer.alloc(headerLength)
    const read = readSync(fd, headerBuf, 0, headerLength, 8)
    // Checked, not assumed: a short read leaves the tail zero-filled, and JSON.parse then
    // reports an unexpected end of input rather than naming the truncated file.
    if (read !== headerLength) {
      throw new Error(
        `asar: short read for the header of ${asarPath} (${read} of ${headerLength} bytes)`,
      )
    }
    const text = headerBuf.toString('utf8')
    const header = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    return { fd, header, base: 8 + headerLength, fileSize }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/**
 * Read one file out of an asar.
 * @param asarPath - the archive path.
 * @param entryPath - POSIX path inside the archive, leading slash optional.
 * @param options - optional settings.
 * @param options.encoding - `'utf8'` (the default) decodes the entry as text; `null`
 * returns the raw `Buffer`. Every entry used to be decoded as UTF-8 unconditionally, which
 * silently mangles a binary entry — a `.png` or `.node` in the archive comes back as lossy
 * text rather than an error. Pass `null` for those.
 * @returns the entry contents, as a string or a `Buffer` per `encoding`.
 * @throws {Error} when the entry does not exist, is a directory, is an `unpacked` entry, or
 * the archive's own bounds do not contain it.
 */
export function readAsarFile(asarPath, entryPath, options = {}) {
  const { encoding = 'utf8' } = options
  const { fd, header, base, fileSize } = readHeader(asarPath)
  try {
    let node = header
    for (const segment of entryPath.replace(/^\//, '').split('/')) {
      node = node?.files?.[segment]
      if (node === undefined) throw new Error(`asar: no such entry "${entryPath}" in ${asarPath}`)
    }
    if (node.files !== undefined) throw new Error(`asar: "${entryPath}" is a directory`)
    // An unpacked entry's header carries no `offset` and no usable `size` — its bytes live
    // beside the archive, in `app.asar.unpacked/`. Falling through would produce `NaN` from
    // `Number(undefined)` and an opaque `RangeError` from `Buffer.alloc`, so it is named here.
    if (node.unpacked === true) {
      throw new Error(
        `asar: "${entryPath}" is an unpacked entry; its bytes are in app.asar.unpacked/, `
        + 'not in the archive',
      )
    }
    // Both values come from the archive's own header, so they are validated against the file
    // rather than trusted: a corrupt header otherwise yields NaN, a negative number, or a huge
    // one, and `Buffer.alloc` answers with `ERR_OUT_OF_RANGE` — an error that names none of the
    // three. The read itself is checked too, or a truncated read returns a zero-padded buffer
    // and a silently wrong string.
    const size = Number(node.size)
    const offset = Number(node.offset)
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`asar: "${entryPath}" declares a non-integer or negative size (${node.size})`)
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`asar: "${entryPath}" declares a non-integer or negative offset (${node.offset})`)
    }
    if (base + offset + size > fileSize) {
      throw new Error(
        `asar: "${entryPath}" runs past the end of ${asarPath} `
        + `(data ends at ${base + offset + size}, file is ${fileSize} bytes)`,
      )
    }
    const buf = Buffer.alloc(size)
    const read = readSync(fd, buf, 0, size, base + offset)
    if (read !== size) {
      throw new Error(`asar: short read for "${entryPath}" (${read} of ${size} bytes)`)
    }
    return encoding === null ? buf : buf.toString(encoding)
  } finally {
    closeSync(fd)
  }
}
