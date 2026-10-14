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
import { openSync, readSync, closeSync, existsSync } from 'node:fs'

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

/** Open an asar and return its header plus the data-section base offset. */
function readHeader(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    readSync(fd, sizeBuf, 0, 8, 0)
    const headerLength = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerLength)
    readSync(fd, headerBuf, 0, headerLength, 8)
    const text = headerBuf.toString('utf8')
    const header = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    return { fd, header, base: 8 + headerLength }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/**
 * Read one file out of an asar.
 * @param asarPath - the archive path.
 * @param entryPath - POSIX path inside the archive, leading slash optional.
 * @returns the file contents as a UTF-8 string.
 * @throws {Error} when the entry does not exist.
 */
export function readAsarFile(asarPath, entryPath) {
  const { fd, header, base } = readHeader(asarPath)
  try {
    let node = header
    for (const segment of entryPath.replace(/^\//, '').split('/')) {
      node = node?.files?.[segment]
      if (node === undefined) throw new Error(`asar: no such entry "${entryPath}" in ${asarPath}`)
    }
    if (node.files !== undefined) throw new Error(`asar: "${entryPath}" is a directory`)
    const size = Number(node.size)
    const offset = Number(node.offset)
    const buf = Buffer.alloc(size)
    readSync(fd, buf, 0, size, base + offset)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}
