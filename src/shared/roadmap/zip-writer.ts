/**
 * Minimal ZIP archive writer (STORE method — no compression) used by the
 * roadmap exporter (`export.ts`) to bundle a rendered document with its
 * attachment files. General-purpose zip libraries stamp each entry with the
 * current wall-clock time by default, which would make two exports of the
 * same roadmap produce different bytes; every entry here instead gets a
 * fixed 1980-01-01 00:00:00 DOS timestamp (the classic reproducible-build
 * epoch), so the same input always serializes to the same archive bytes.
 */

const CRC_TABLE = buildCrcTable()

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0
    const tableEntry = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0
    crc = tableEntry ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// 1980-01-01 00:00:00 — DOS epoch, encoded per the ZIP spec's date/time fields.
const DOS_TIME = 0
const DOS_DATE = (1 << 5) | 1

function writeUint32LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true)
}

function writeUint16LE(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true)
}

interface ZipEntry {
  path: string
  data: Uint8Array
}

/** Builds a valid, deterministic (uncompressed) ZIP archive in memory. */
export class ZipBuilder {
  private readonly entries: ZipEntry[] = []
  private readonly seenPaths = new Set<string>()

  /** Add a file. `path` must be a forward-slash relative path, unique within the archive. */
  addFile(path: string, data: Uint8Array): void {
    if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('..')) {
      throw new Error(`Unsafe zip entry path: ${JSON.stringify(path)}`)
    }
    if (this.seenPaths.has(path)) {
      throw new Error(`Duplicate zip entry path: ${JSON.stringify(path)}`)
    }
    this.seenPaths.add(path)
    this.entries.push({ path, data })
  }

  /** Serialize every added file into ZIP archive bytes. */
  build(): Uint8Array {
    const encoder = new TextEncoder()
    const localParts: Uint8Array[] = []
    const centralParts: Uint8Array[] = []
    let offset = 0

    for (const entry of this.entries) {
      const nameBytes = encoder.encode(entry.path)
      const crc = crc32(entry.data)
      const size = entry.data.length

      const local = new Uint8Array(30 + nameBytes.length)
      const localView = new DataView(local.buffer)
      writeUint32LE(localView, 0, 0x04034b50)
      writeUint16LE(localView, 4, 20) // version needed to extract
      writeUint16LE(localView, 6, 0x0800) // general purpose flag: UTF-8 name
      writeUint16LE(localView, 8, 0) // compression method: store
      writeUint16LE(localView, 10, DOS_TIME)
      writeUint16LE(localView, 12, DOS_DATE)
      writeUint32LE(localView, 14, crc)
      writeUint32LE(localView, 18, size)
      writeUint32LE(localView, 22, size)
      writeUint16LE(localView, 26, nameBytes.length)
      writeUint16LE(localView, 28, 0) // extra field length
      local.set(nameBytes, 30)
      localParts.push(local, entry.data)

      const central = new Uint8Array(46 + nameBytes.length)
      const centralView = new DataView(central.buffer)
      writeUint32LE(centralView, 0, 0x02014b50)
      writeUint16LE(centralView, 4, 20) // version made by
      writeUint16LE(centralView, 6, 20) // version needed to extract
      writeUint16LE(centralView, 8, 0x0800)
      writeUint16LE(centralView, 10, 0) // compression method: store
      writeUint16LE(centralView, 12, DOS_TIME)
      writeUint16LE(centralView, 14, DOS_DATE)
      writeUint32LE(centralView, 16, crc)
      writeUint32LE(centralView, 20, size)
      writeUint32LE(centralView, 24, size)
      writeUint16LE(centralView, 28, nameBytes.length)
      writeUint16LE(centralView, 30, 0) // extra field length
      writeUint16LE(centralView, 32, 0) // file comment length
      writeUint16LE(centralView, 34, 0) // disk number start
      writeUint16LE(centralView, 36, 0) // internal file attributes
      writeUint32LE(centralView, 38, 0) // external file attributes
      writeUint32LE(centralView, 42, offset) // local header offset
      central.set(nameBytes, 46)
      centralParts.push(central)

      offset += local.length + entry.data.length
    }

    const centralDirOffset = offset
    const centralDirSize = centralParts.reduce((sum, part) => sum + part.length, 0)

    const eocd = new Uint8Array(22)
    const eocdView = new DataView(eocd.buffer)
    writeUint32LE(eocdView, 0, 0x06054b50)
    writeUint16LE(eocdView, 4, 0) // disk number
    writeUint16LE(eocdView, 6, 0) // disk where central directory starts
    writeUint16LE(eocdView, 8, this.entries.length)
    writeUint16LE(eocdView, 10, this.entries.length)
    writeUint32LE(eocdView, 12, centralDirSize)
    writeUint32LE(eocdView, 16, centralDirOffset)
    writeUint16LE(eocdView, 20, 0) // comment length

    const total = new Uint8Array(centralDirOffset + centralDirSize + eocd.length)
    let pos = 0
    for (const part of [...localParts, ...centralParts, eocd]) {
      total.set(part, pos)
      pos += part.length
    }
    return total
  }
}
