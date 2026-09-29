/**
 * A read-only view of an Electron `app.asar`, enough to list what a packaged app
 * actually contains and read small files back. Written here rather than taken
 * from `@electron/asar` because that is only a transitive dependency of
 * electron-builder, and pnpm does not link transitive dependencies where a
 * repository script can import them.
 *
 * Layout: an 8-byte size pickle (payload length 4, then the header pickle's
 * byte length), the header pickle (payload length, JSON string length, JSON),
 * then file data. A file entry's `offset` counts from the end of the header
 * pickle; an `unpacked` entry lives at the same path under `app.asar.unpacked`,
 * and counts only while it is still there.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'

interface AsarFile {
  size: number
  offset?: string | undefined
  unpacked: boolean
}

type AsarNode = { files: Record<string, AsarNode> } | AsarFile | { link: string }

const nodeSchema: z.ZodType<AsarNode> = z.lazy(() =>
  z.union([
    z.object({ files: z.record(z.string(), nodeSchema) }),
    z.object({ link: z.string() }),
    z.object({
      size: z.number(),
      offset: z.string().optional(),
      unpacked: z.boolean().optional().default(false),
    }),
  ]),
)

export interface AsarArchive {
  /** Every file path in the archive (packed or unpacked), `/`-separated. */
  files: string[]
  readFile(path: string): Buffer
}

function readExactly(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length)
  const read = readSync(fd, buffer, 0, length, position)
  if (read !== length) throw new Error(`[asar] short read at ${String(position)}`)
  return buffer
}

export function openAsar(asarPath: string): AsarArchive {
  const fd = openSync(asarPath, 'r')
  let header: AsarNode
  let dataOffset: number
  try {
    const size = readExactly(fd, 8, 0)
    if (size.readUInt32LE(0) !== 4) throw new Error(`[asar] ${asarPath} is not an asar archive`)
    const headerSize = size.readUInt32LE(4)
    const headerPickle = readExactly(fd, headerSize, 8)
    const jsonLength = headerPickle.readInt32LE(4)
    const json = headerPickle.subarray(8, 8 + jsonLength).toString('utf8')
    const parsed = safeJsonParse(json, decodeWithSchema(nodeSchema))
    if (!parsed) throw new Error(`[asar] ${asarPath} has an unreadable header`)
    header = parsed
    dataOffset = 8 + headerSize
  } finally {
    closeSync(fd)
  }

  const entries = new Map<string, AsarFile>()
  const walk = (node: AsarNode, prefix: string): void => {
    if ('files' in node) {
      for (const [name, child] of Object.entries(node.files)) {
        walk(child, prefix ? `${prefix}/${name}` : name)
      }
    } else if ('size' in node) {
      // The header keeps listing an unpacked file after it is deleted from
      // app.asar.unpacked (after-pack.cjs drops the other architecture's
      // keyring binary that way); it is not in the app.
      if (!node.unpacked || existsSync(join(`${asarPath}.unpacked`, prefix))) {
        entries.set(prefix, node)
      }
    }
  }
  walk(header, '')

  return {
    files: [...entries.keys()].sort(),
    readFile(path: string): Buffer {
      const entry = entries.get(path)
      if (!entry) throw new Error(`[asar] ${path} is not in ${asarPath}`)
      if (entry.unpacked) return readFileSync(join(`${asarPath}.unpacked`, path))
      if (entry.offset === undefined) throw new Error(`[asar] ${path} has no offset`)
      const handle = openSync(asarPath, 'r')
      try {
        return readExactly(handle, entry.size, dataOffset + Number(entry.offset))
      } finally {
        closeSync(handle)
      }
    },
  }
}
