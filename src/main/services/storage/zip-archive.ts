import { promisify } from 'node:util'
import { crc32, deflateRaw } from 'node:zlib'

/**
 * A minimal, dependency-free ZIP writer (deflate + store, no zip64).
 *
 * Threads are exported as an archive of their on-disk directory, and the whole
 * point of that export is that any extractor can open it — so this writes the
 * plainest possible archive: one local header + body per file, a central
 * directory, and an end-of-central-directory record. Directory entries are left
 * implicit; extractors create them from the entry paths.
 */

const deflateRawAsync = promisify(deflateRaw)

/** One file in the archive. Sizes/CRC are computed here, not supplied. */
export interface ZipEntry {
  /** Path inside the archive: relative, POSIX-separated, no leading slash. */
  path: string
  data: Uint8Array
  /** Stored as a DOS timestamp, which only spans 1980–2107 (clamped). */
  modifiedAt: Date
}

const LOCAL_HEADER_SIG = 0x0403_4b50
const CENTRAL_HEADER_SIG = 0x0201_4b50
const EOCD_SIG = 0x0605_4b50
const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const EOCD_BYTES = 22
/** 2.0 — the floor for deflate. */
const VERSION_NEEDED = 20
/** Bit 11: entry names are UTF-8 rather than CP437. */
const UTF8_NAME_FLAG = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** Without zip64, offsets/sizes are 32-bit and the entry count is 16-bit. */
const MAX_ZIP_BYTES = 0xffff_ffff
const MAX_ZIP_ENTRIES = 0xffff

interface StagedEntry {
  name: Buffer
  method: number
  time: number
  date: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/** MS-DOS date/time halves, clamped to the range the format can represent. */
function dosTimestamp(value: Date): { time: number; date: number } {
  const year = value.getFullYear()
  if (!Number.isFinite(year) || year < 1980) return { time: 0, date: (1 << 5) | 1 }
  if (year > 2107) return { time: (23 << 11) | (59 << 5) | 29, date: (127 << 9) | (12 << 5) | 31 }
  return {
    // Seconds have 5 bits, so the format stores them in two-second units.
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | (value.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  }
}

function localHeader(entry: StagedEntry): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_BYTES + entry.name.length)
  header.writeUInt32LE(LOCAL_HEADER_SIG, 0)
  header.writeUInt16LE(VERSION_NEEDED, 4)
  header.writeUInt16LE(UTF8_NAME_FLAG, 6)
  header.writeUInt16LE(entry.method, 8)
  header.writeUInt16LE(entry.time, 10)
  header.writeUInt16LE(entry.date, 12)
  header.writeUInt32LE(entry.crc, 14)
  header.writeUInt32LE(entry.compressedSize, 18)
  header.writeUInt32LE(entry.uncompressedSize, 22)
  header.writeUInt16LE(entry.name.length, 26)
  header.writeUInt16LE(0, 28)
  entry.name.copy(header, LOCAL_HEADER_BYTES)
  return header
}

function centralHeader(entry: StagedEntry): Buffer {
  const header = Buffer.alloc(CENTRAL_HEADER_BYTES + entry.name.length)
  header.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
  header.writeUInt16LE(VERSION_NEEDED, 4)
  header.writeUInt16LE(VERSION_NEEDED, 6)
  header.writeUInt16LE(UTF8_NAME_FLAG, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt16LE(entry.time, 12)
  header.writeUInt16LE(entry.date, 14)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.compressedSize, 20)
  header.writeUInt32LE(entry.uncompressedSize, 24)
  header.writeUInt16LE(entry.name.length, 28)
  // extra, comment, disk number, internal attrs, external attrs — all zero.
  header.writeUInt32LE(entry.localHeaderOffset, 42)
  entry.name.copy(header, CENTRAL_HEADER_BYTES)
  return header
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const record = Buffer.alloc(EOCD_BYTES)
  record.writeUInt32LE(EOCD_SIG, 0)
  record.writeUInt16LE(count, 8)
  record.writeUInt16LE(count, 10)
  record.writeUInt32LE(size, 12)
  record.writeUInt32LE(offset, 16)
  return record
}

/**
 * Build a ZIP archive from `entries`, in the order given. Compression is async
 * so a large export yields between files instead of stalling the main process's
 * event loop. Throws when the result would need zip64.
 */
export async function createZipArchive(
  entries: readonly ZipEntry[],
): Promise<Uint8Array<ArrayBuffer>> {
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(
      `Archive has too many files (${String(entries.length)}); the limit is ${String(MAX_ZIP_ENTRIES)}`,
    )
  }
  const chunks: Buffer[] = []
  const staged: StagedEntry[] = []
  let offset = 0
  for (const entry of entries) {
    const deflated = await deflateRawAsync(entry.data)
    // Incompressible data (already-compressed images, random blobs) deflates
    // larger than it started; store those verbatim instead.
    const stored = deflated.length >= entry.data.length
    const body = stored
      ? Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.length)
      : deflated
    const stamp = dosTimestamp(entry.modifiedAt)
    const item: StagedEntry = {
      name: Buffer.from(entry.path, 'utf8'),
      method: stored ? METHOD_STORE : METHOD_DEFLATE,
      time: stamp.time,
      date: stamp.date,
      crc: crc32(entry.data),
      compressedSize: body.length,
      uncompressedSize: entry.data.length,
      localHeaderOffset: offset,
    }
    const header = localHeader(item)
    chunks.push(header, body)
    staged.push(item)
    offset += header.length + body.length
    if (offset > MAX_ZIP_BYTES) throw new Error('Archive is too large for the zip format')
  }
  const centralOffset = offset
  let centralSize = 0
  for (const item of staged) {
    const header = centralHeader(item)
    chunks.push(header)
    centralSize += header.length
  }
  if (centralOffset + centralSize + EOCD_BYTES > MAX_ZIP_BYTES) {
    throw new Error('Archive is too large for the zip format')
  }
  chunks.push(endOfCentralDirectory(staged.length, centralSize, centralOffset))
  return Buffer.concat(chunks)
}
