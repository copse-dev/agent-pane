import { promisify } from 'node:util'
import { crc32, inflateRaw } from 'node:zlib'

/**
 * The reading half of {@link ./zip-archive.ts}: parse a zip's central directory
 * and decompress individual entries.
 *
 * Deliberately not a general-purpose unzip. It reads what the writer here emits
 * plus what ordinary tools produce (deflate + store, no zip64, no encryption),
 * and refuses everything else with a message that says which feature is
 * missing — a clear "this archive is encrypted" beats a partial extraction that
 * silently drops files.
 *
 * Every entry name that comes out of here is untrusted attacker-controlled
 * input: the archive may have been downloaded, mailed, or handed over by a
 * third party. Nothing in this module touches the filesystem, so the containment
 * rules live with the extractor — but see {@link isUnsafeEntryPath}, which is
 * the check that extractor must apply.
 */

const inflateRawAsync = promisify(inflateRaw)

const LOCAL_HEADER_SIG = 0x0403_4b50
const CENTRAL_HEADER_SIG = 0x0201_4b50
const EOCD_SIG = 0x0605_4b50
const ZIP64_EOCD_LOCATOR_SIG = 0x0706_4b50
const EOCD_BYTES = 22
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** Bit 0 of the general-purpose flags: entry data is encrypted. */
const ENCRYPTED_FLAG = 0x0001
/** A zip comment is a 16-bit length, so the EOCD starts at most this far back. */
const MAX_COMMENT_BYTES = 0xffff
/** Sentinels the format uses to say "the real value is in a zip64 record". */
const ZIP64_SENTINEL_32 = 0xffff_ffff
const ZIP64_SENTINEL_16 = 0xffff

/** Unix file-type mask and the symlink type, as stored in the high external attrs. */
const UNIX_TYPE_MASK = 0xf000
const UNIX_TYPE_SYMLINK = 0xa000
/** MS-DOS attribute bit marking a directory entry. */
const MSDOS_DIRECTORY_FLAG = 0x10

export interface ZipEntryInfo {
  /** Entry name exactly as the archive stores it. Untrusted — see `isUnsafeEntryPath`. */
  path: string
  compressedSize: number
  uncompressedSize: number
  /** Compression method: 0 (store) or 8 (deflate); anything else fails to read. */
  method: number
  crc: number
  modifiedAt: Date
  isDirectory: boolean
  /** A unix symlink entry, whose "contents" are a target path rather than a file. */
  isSymlink: boolean
  localHeaderOffset: number
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipFormatError'
  }
}

function asBuffer(archive: Uint8Array): Buffer {
  return Buffer.from(archive.buffer, archive.byteOffset, archive.length)
}

/** A DOS date/time pair back to a Date, in local time (the format carries no zone). */
function fromDosTimestamp(time: number, date: number): Date {
  const year = 1980 + ((date >> 9) & 0x7f)
  const month = ((date >> 5) & 0x0f) - 1
  const day = date & 0x1f
  const hours = (time >> 11) & 0x1f
  const minutes = (time >> 5) & 0x3f
  const seconds = (time & 0x1f) * 2
  // A zero date field means "not recorded"; the epoch floor beats an Invalid Date.
  if (date === 0) return new Date(1980, 0, 1)
  return new Date(year, Math.max(0, month), Math.max(1, day), hours, minutes, seconds)
}

/** Byte offset of the end-of-central-directory record, scanning back past any comment. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - EOCD_BYTES - MAX_COMMENT_BYTES)
  for (let offset = buffer.length - EOCD_BYTES; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIG) continue
    // The comment length has to account for exactly the bytes that follow, or
    // this is a stray signature inside compressed data rather than the record.
    if (buffer.readUInt16LE(offset + 20) === buffer.length - offset - EOCD_BYTES) return offset
  }
  throw new ZipFormatError('Not a zip file (no end-of-central-directory record).')
}

/**
 * Read the central directory. Entry order is the archive's own, which is the
 * order tools wrote it in and therefore the most useful one to show a user.
 */
export function readZipDirectory(archive: Uint8Array): ZipEntryInfo[] {
  const buffer = asBuffer(archive)
  if (buffer.length < EOCD_BYTES) throw new ZipFormatError('Not a zip file (too short).')
  const eocd = findEndOfCentralDirectory(buffer)

  const count = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (
    count === ZIP64_SENTINEL_16 ||
    centralSize === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32 ||
    (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG)
  ) {
    throw new ZipFormatError('This is a zip64 archive, which is not supported.')
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipFormatError('Zip central directory is truncated.')
  }

  const entries: ZipEntryInfo[] = []
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIG) {
      throw new ZipFormatError('Zip central directory is corrupt.')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    if ((flags & ENCRYPTED_FLAG) !== 0) {
      throw new ZipFormatError('This zip is encrypted, which is not supported.')
    }
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttrs = buffer.readUInt32LE(cursor + 38)
    const path = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const unixMode = externalAttrs >>> 16
    entries.push({
      path,
      method: buffer.readUInt16LE(cursor + 10),
      crc: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      modifiedAt: fromDosTimestamp(
        buffer.readUInt16LE(cursor + 12),
        buffer.readUInt16LE(cursor + 14),
      ),
      isDirectory: path.endsWith('/') || (externalAttrs & MSDOS_DIRECTORY_FLAG) !== 0,
      isSymlink: (unixMode & UNIX_TYPE_MASK) === UNIX_TYPE_SYMLINK,
      localHeaderOffset: buffer.readUInt32LE(cursor + 42),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Decompress one entry's bytes and verify its CRC.
 *
 * The local header is re-read for its own name/extra lengths rather than reusing
 * the central directory's: the two are allowed to differ, and trusting the wrong
 * one puts the read a few bytes into the body.
 */
export async function readZipEntry(archive: Uint8Array, entry: ZipEntryInfo): Promise<Uint8Array> {
  const buffer = asBuffer(archive)
  const header = entry.localHeaderOffset
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_HEADER_SIG) {
    throw new ZipFormatError(`Zip entry ${entry.path} has no local header.`)
  }
  const bodyStart =
    header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28)
  if (bodyStart + entry.compressedSize > buffer.length) {
    throw new ZipFormatError(`Zip entry ${entry.path} is truncated.`)
  }
  const body = buffer.subarray(bodyStart, bodyStart + entry.compressedSize)

  let data: Buffer
  if (entry.method === METHOD_STORE) data = Buffer.from(body)
  else if (entry.method === METHOD_DEFLATE) {
    try {
      data = await inflateRawAsync(body)
    } catch {
      // zlib's own messages ("invalid distance too far back") describe the
      // bitstream, not the file; say which entry failed and why it matters.
      throw new ZipFormatError(
        `Zip entry ${entry.path} could not be decompressed — the archive is corrupt.`,
      )
    }
  } else {
    throw new ZipFormatError(
      `Zip entry ${entry.path} uses compression method ${String(entry.method)}; only store and deflate are supported.`,
    )
  }
  if (crc32(data) !== entry.crc) {
    throw new ZipFormatError(
      `Zip entry ${entry.path} failed its checksum — the archive is corrupt.`,
    )
  }
  return data
}

/**
 * Whether an entry name must not be written to disk relative to an extraction
 * root — the "zip slip" check.
 *
 * Rejects rather than sanitises. A name that tries to escape is not a file the
 * user meant to receive under a different name; it is an archive doing something
 * it should not, and the extractor says so instead of quietly rewriting it.
 * Backslashes are refused outright because Windows treats them as separators, so
 * `..\..\x` is an escape there and an innocent filename everywhere else.
 */
export function isUnsafeEntryPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.startsWith('\\')) return true
  if (path.includes('\\')) return true
  if (path.includes('\0')) return true
  // `C:` / `C:/…` — a drive-relative or drive-absolute Windows path.
  if (/^[A-Za-z]:/.test(path)) return true
  return path.split('/').some((segment) => segment === '..')
}
