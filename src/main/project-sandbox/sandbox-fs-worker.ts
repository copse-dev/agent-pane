/**
 * Seatbelt-confined fs worker (spawned via ASRT). Two modes:
 *
 * - One-shot (legacy/fallback): one JSON request on argv[2] (or COPSE_SANDBOX_FS_REQUEST),
 *   one JSON response on stdout, then exit.
 * - Server (default for the renderer fs gateway): when COPSE_SANDBOX_FS_SERVER is set, read
 *   newline-delimited JSON requests from stdin and write one newline-delimited JSON response
 *   per request to stdout, staying alive until stdin closes. This amortizes the (heavy)
 *   process-spawn + seatbelt-wrap cost across every directory listing / file read instead of
 *   paying it per call.
 *
 * Must stay free of electron imports so it bundles as a standalone script.
 */
import { errorMessage } from '@shared/errors.ts'
import * as fsp from 'node:fs/promises'
import { dirname } from 'node:path'
import { isRecord, parseJsonUnknown } from '@shared/unknown-value.ts'

type ReadFileReq = { op: 'readFile'; path: string; encoding: 'utf-8' }
type WriteFileReq = { op: 'writeFile'; path: string; content: string; encoding: 'utf-8' }
type ReaddirReq = { op: 'readdir'; path: string }
type StatEntryReq = { op: 'statDir'; path: string }

type Request = ReadFileReq | WriteFileReq | ReaddirReq | StatEntryReq

type ResponseBody =
  | { ok: true; data?: string; entries?: string[]; dirents?: { name: string; isDir: boolean }[] }
  | { ok: false; error: string }

const REQUEST_ENV = 'COPSE_SANDBOX_FS_REQUEST'
const SERVER_ENV = 'COPSE_SANDBOX_FS_SERVER'

function parseRequest(value: unknown): Request | null {
  if (!isRecord(value) || typeof value['path'] !== 'string') return null
  switch (value['op']) {
    case 'readFile':
      return value['encoding'] === 'utf-8'
        ? { op: value['op'], path: value['path'], encoding: value['encoding'] }
        : null
    case 'writeFile':
      return value['encoding'] === 'utf-8' && typeof value['content'] === 'string'
        ? {
            op: value['op'],
            path: value['path'],
            content: value['content'],
            encoding: value['encoding'],
          }
        : null
    case 'readdir':
    case 'statDir':
      return { op: value['op'], path: value['path'] }
    default:
      return null
  }
}

async function handle(req: Request): Promise<ResponseBody> {
  switch (req.op) {
    case 'readFile': {
      const data = await fsp.readFile(req.path, req.encoding)
      return { ok: true, data }
    }
    case 'writeFile': {
      await fsp.mkdir(dirname(req.path), { recursive: true })
      await fsp.writeFile(req.path, req.content, req.encoding)
      return { ok: true }
    }
    case 'readdir': {
      const entries = await fsp.readdir(req.path)
      return { ok: true, entries }
    }
    case 'statDir': {
      const dirents = await fsp.readdir(req.path, { withFileTypes: true })
      return { ok: true, dirents: dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() })) }
    }
  }
}

function errorBody(err: unknown): ResponseBody {
  return { ok: false, error: errorMessage(err) }
}

function oneShot(): void {
  const raw = process.argv[2] ?? process.env[REQUEST_ENV]
  if (!raw) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing request argument' }))
    process.exit(1)
  }
  let req: Request | null
  try {
    req = parseRequest(parseJsonUnknown(raw))
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid JSON request' }))
    process.exit(1)
  }
  if (!req) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid request' }))
    process.exit(1)
  }
  handle(req)
    .then((body) => {
      process.stdout.write(JSON.stringify(body))
      if (!body.ok) process.exit(1)
    })
    .catch((err: unknown) => {
      process.stdout.write(JSON.stringify(errorBody(err)))
      process.exit(1)
    })
}

/**
 * Server loop: each stdin line is `{ id, ...Request }`; each stdout line is `{ id, ...ResponseBody }`.
 * JSON.stringify escapes embedded newlines, so the only literal '\n' on the wire is our delimiter.
 */
function server(): void {
  let buffer = ''
  const writeResponse = (id: number, body: ResponseBody): void => {
    process.stdout.write(`${JSON.stringify({ id, ...body })}\n`)
  }

  const dispatch = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let id: number
    let req: Request | null
    try {
      const parsed = parseJsonUnknown(trimmed)
      if (!isRecord(parsed) || typeof parsed['id'] !== 'number') return
      id = parsed['id']
      req = parseRequest(parsed)
    } catch {
      // Unframed/garbled line — nothing to correlate it to, so drop it.
      return
    }
    if (!req) {
      writeResponse(id, { ok: false, error: 'invalid request' })
      return
    }
    handle(req)
      .then((body) => {
        writeResponse(id, body)
      })
      .catch((err: unknown) => {
        writeResponse(id, errorBody(err))
      })
  }

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      dispatch(line)
      nl = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    process.exit(0)
  })
}

if (process.env[SERVER_ENV]) {
  server()
} else {
  oneShot()
}
