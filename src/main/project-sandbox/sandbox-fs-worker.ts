/**
 * Seatbelt-confined fs worker (spawned via ASRT). One JSON request on argv[2], one JSON response on stdout.
 * Must stay free of electron imports so it bundles as a standalone script.
 */
import * as fsp from 'node:fs/promises'
import { dirname } from 'node:path'

type ReadFileReq = { op: 'readFile'; path: string; encoding: 'utf-8' }
type WriteFileReq = { op: 'writeFile'; path: string; content: string; encoding: 'utf-8' }
type ReaddirReq = { op: 'readdir'; path: string }
type StatEntryReq = { op: 'statDir'; path: string }

type Request = ReadFileReq | WriteFileReq | ReaddirReq | StatEntryReq

type Response =
  | { ok: true; data?: string; entries?: string[]; dirents?: { name: string; isDir: boolean }[] }
  | { ok: false; error: string }

function fail(message: string): never {
  const out: Response = { ok: false, error: message }
  process.stdout.write(JSON.stringify(out))
  process.exit(1)
}

async function main(): Promise<void> {
  const raw = process.argv[2]
  if (!raw) fail('missing request argument')

  let req: Request
  try {
    req = JSON.parse(raw) as Request
  } catch {
    fail('invalid JSON request')
  }

  try {
    switch (req.op) {
      case 'readFile': {
        const data = await fsp.readFile(req.path, req.encoding)
        const out: Response = { ok: true, data }
        process.stdout.write(JSON.stringify(out))
        return
      }
      case 'writeFile': {
        await fsp.mkdir(dirname(req.path), { recursive: true })
        await fsp.writeFile(req.path, req.content, req.encoding)
        process.stdout.write(JSON.stringify({ ok: true } satisfies Response))
        return
      }
      case 'readdir': {
        const entries = await fsp.readdir(req.path)
        const out: Response = { ok: true, entries }
        process.stdout.write(JSON.stringify(out))
        return
      }
      case 'statDir': {
        const dirents = await fsp.readdir(req.path, { withFileTypes: true })
        const mapped = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
        const out: Response = { ok: true, dirents: mapped }
        process.stdout.write(JSON.stringify(out))
        return
      }
      default:
        fail(`unknown op: ${(req as { op: string }).op}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const out: Response = { ok: false, error: message }
    process.stdout.write(JSON.stringify(out))
    process.exit(1)
  }
}

void main()
