import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type {
  McpSecretEntryInput,
  McpUserServer,
  McpUserServerField,
  McpUserServerInput,
  McpUserServerList,
  McpUserServerSaveResult,
} from '@shared/types/mcp-user-servers.ts'
import { getElectronUserDataPath } from '../electron-app-runtime.ts'

/**
 * Settings → MCP servers edits Copse's own `mcp.json` under userData: a user
 * source the registry already reads (and trusts like `~/.cursor/mcp.json`), so
 * a server added here loads through the same path as a hand-written one. The
 * other config files are never rewritten; they belong to the user's editor or
 * to the repo.
 *
 * The file is rewritten whole, keeping every key and server this module does
 * not understand, and refuses to touch a file it cannot parse rather than
 * replace it with something smaller.
 */
export function copseUserMcpConfigPath(): string {
  return join(getElectronUserDataPath(), 'mcp.json')
}

const MAX_NAME_LENGTH = 64
const MAX_TEXT = 8192
const MAX_ENTRIES = 64

// The name becomes the `mcp__<name>__<tool>` prefix, which is split on the
// first `__`, so a name may not contain one.
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
// RFC 9110 token characters.
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

const secretEntrySchema = z.object({
  key: z.string().max(256),
  value: z.string().max(MAX_TEXT).optional(),
})

/** IPC shape of a save. Semantic checks (names, URL, duplicates) run in {@link saveUserMcpServer}. */
export const mcpUserServerInputSchema: z.ZodType<McpUserServerInput> = z.discriminatedUnion(
  'transport',
  [
    z.object({
      transport: z.literal('stdio'),
      name: z.string().max(256),
      command: z.string().max(MAX_TEXT),
      args: z.array(z.string().max(MAX_TEXT)).max(256),
      cwd: z.string().max(MAX_TEXT).optional(),
      env: z.array(secretEntrySchema).max(MAX_ENTRIES),
    }),
    z.object({
      transport: z.literal('http'),
      name: z.string().max(256),
      url: z.string().max(MAX_TEXT),
      headers: z.array(secretEntrySchema).max(MAX_ENTRIES),
    }),
  ],
)

const rawFileSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  servers: z.unknown().optional(),
})
type RawFile = z.infer<typeof rawFileSchema>

const rawEntrySchema = z.looseObject({
  type: z.unknown().optional(),
  command: z.unknown().optional(),
  args: z.unknown().optional(),
  cwd: z.unknown().optional(),
  env: z.unknown().optional(),
  url: z.unknown().optional(),
  headers: z.unknown().optional(),
})
type RawEntry = z.infer<typeof rawEntrySchema>

// Fields this module owns in an entry; anything else (`disabled`, comments a
// user added) is carried over unchanged when the entry is rewritten.
const OWNED_ENTRY_KEYS = new Set(['type', 'command', 'args', 'cwd', 'env', 'url', 'headers'])

const stringRecordSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

function storedSecrets(value: unknown): Map<string, string> {
  const parsed = stringRecordSchema.safeParse(value)
  if (!parsed.success) return new Map()
  return new Map(Object.entries(parsed.data).map(([k, v]) => [k, String(v)]))
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

/** The editable view of one raw entry, or null when it is neither stdio nor http. */
function toUserServer(name: string, raw: RawEntry): McpUserServer | null {
  const url = stringOf(raw.url)
  const command = stringOf(raw.command)
  const isHttp =
    raw.type === 'http' ||
    raw.type === 'streamable-http' ||
    raw.type === 'sse' ||
    (raw.type !== 'stdio' && url !== undefined)
  if (isHttp && url !== undefined) {
    return {
      transport: 'http',
      name,
      url,
      headers: [...storedSecrets(raw.headers).keys()].map((key) => ({ key })),
    }
  }
  if (!isHttp && command !== undefined) {
    const cwd = stringOf(raw.cwd)
    return {
      transport: 'stdio',
      name,
      command,
      args: stringArray(raw.args),
      ...(cwd === undefined ? {} : { cwd }),
      env: [...storedSecrets(raw.env).keys()].map((key) => ({ key })),
    }
  }
  return null
}

type ReadResult = { ok: true; file: RawFile } | { ok: false; error: string }

async function readRawFile(path: string): Promise<ReadResult> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf-8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { ok: true, file: {} }
    }
    return { ok: false, error: `Could not read ${path}.` }
  }
  if (!text.trim()) return { ok: true, file: {} }
  const file = safeJsonParse(text, decodeWithSchema(rawFileSchema))
  if (file === null) {
    return {
      ok: false,
      error: `${path} is not a JSON object with an "mcpServers" map. Fix it by hand first.`,
    }
  }
  // The legacy `{ servers: [...] }` shape is only read when `mcpServers` is
  // absent, so adding `mcpServers` would silently drop every legacy server.
  if (file.mcpServers === undefined && file.servers !== undefined) {
    return {
      ok: false,
      error: `${path} uses the older "servers" list. Move its servers into "mcpServers" to edit them here.`,
    }
  }
  return { ok: true, file }
}

function listFrom(path: string, file: RawFile): McpUserServerList {
  const servers: McpUserServer[] = []
  for (const [name, value] of Object.entries(file.mcpServers ?? {})) {
    const raw = rawEntrySchema.safeParse(value)
    if (!raw.success) continue
    const server = toUserServer(name, raw.data)
    if (server) servers.push(server)
  }
  return { path, servers }
}

export async function listUserMcpServers(
  path: string = copseUserMcpConfigPath(),
): Promise<McpUserServerList> {
  const read = await readRawFile(path)
  if (!read.ok) return { path, servers: [], error: read.error }
  return listFrom(path, read.file)
}

async function writeRawFile(path: string, file: RawFile): Promise<void> {
  // Env vars and headers can hold API keys: keep the file private to the user.
  await fs.mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await fs.rename(temporary, path)
  } catch (err) {
    await fs.rm(temporary, { force: true })
    throw err
  }
  await fs.chmod(path, 0o600)
}

// One read-modify-write at a time, so two quick saves cannot drop each other.
let writeTail: Promise<unknown> = Promise.resolve()
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeTail.then(operation)
  writeTail = result.catch(() => undefined)
  return result
}

type Rejection = Extract<McpUserServerSaveResult, { ok: false }>
type Built<T> = { ok: true; value: T } | Rejection

function reject(field: McpUserServerField, message: string): Rejection {
  return { ok: false, field, message }
}

function resolveSecrets(
  entries: readonly McpSecretEntryInput[],
  stored: ReadonlyMap<string, string>,
  field: 'env' | 'headers',
): Built<Record<string, string>> {
  const keyPattern = field === 'env' ? ENV_KEY_PATTERN : HEADER_NAME_PATTERN
  const noun = field === 'env' ? 'environment variable' : 'header'
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const key = entry.key.trim()
    if (!key && !entry.value) continue
    if (!keyPattern.test(key)) {
      return reject(field, `"${key || entry.key}" is not a valid ${noun} name.`)
    }
    if (Object.hasOwn(out, key)) return reject(field, `The ${noun} ${key} is listed twice.`)
    const value = entry.value ?? stored.get(key)
    if (value === undefined) return reject(field, `Enter a value for ${key}.`)
    out[key] = value
  }
  return { ok: true, value: out }
}

function preservedExtras(raw: RawEntry | undefined): Record<string, unknown> {
  if (!raw) return {}
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !OWNED_ENTRY_KEYS.has(key)))
}

function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function buildEntry(
  input: McpUserServerInput,
  previous: RawEntry | undefined,
): Built<Record<string, unknown>> {
  const extras = preservedExtras(previous)
  if (input.transport === 'stdio') {
    const command = input.command.trim()
    if (!command) return reject('command', 'Enter the command that starts the server.')
    const env = resolveSecrets(input.env, storedSecrets(previous?.env), 'env')
    if (!env.ok) return env
    const cwd = input.cwd?.trim()
    return {
      ok: true,
      value: {
        ...extras,
        command,
        args: input.args.filter((arg) => arg !== ''),
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(env.value).length > 0 ? { env: env.value } : {}),
      },
    }
  }
  const url = input.url.trim()
  if (!isHttpUrl(url)) return reject('url', 'Enter an http:// or https:// URL.')
  // Stored header values are only kept for the URL they were written for, so
  // pointing an entry at another host cannot carry its credentials along.
  const storedHeaders =
    previous?.url === url ? storedSecrets(previous.headers) : new Map<string, string>()
  const headers = resolveSecrets(input.headers, storedHeaders, 'headers')
  if (!headers.ok) return headers
  return {
    ok: true,
    value: {
      ...extras,
      type: 'http',
      url,
      ...(Object.keys(headers.value).length > 0 ? { headers: headers.value } : {}),
    },
  }
}

export interface SaveUserMcpServerOptions {
  /** The entry being edited; omit when adding. Renaming moves the entry. */
  previousName?: string
  /**
   * Server names other sources already use, with a phrase naming that source.
   * A name the user's own file already holds is not listed here.
   */
  takenNames: ReadonlyMap<string, string>
  path?: string
}

/** Add or replace one server in Copse's `mcp.json`. Nothing is written on a rejection. */
export function saveUserMcpServer(
  input: McpUserServerInput,
  options: SaveUserMcpServerOptions,
): Promise<McpUserServerSaveResult> {
  const path = options.path ?? copseUserMcpConfigPath()
  return serialized(async () => {
    const name = input.name.trim()
    if (!name) return reject('name', 'Enter a name for the server.')
    if (name.length > MAX_NAME_LENGTH || !SERVER_NAME_PATTERN.test(name) || name.includes('__')) {
      return reject(
        'name',
        'Use letters, numbers, single underscores and hyphens, starting with a letter or number.',
      )
    }
    const read = await readRawFile(path)
    if (!read.ok) return reject('form', read.error)
    const servers: Record<string, unknown> = { ...read.file.mcpServers }
    const previousName = options.previousName
    if (previousName !== undefined && !Object.hasOwn(servers, previousName)) {
      return reject('form', `"${previousName}" is no longer in ${path}. Reload and try again.`)
    }
    if (name !== previousName) {
      if (Object.hasOwn(servers, name)) {
        return reject('name', `A server named "${name}" is already in your Copse config.`)
      }
      const takenBy = options.takenNames.get(name)
      if (takenBy !== undefined) {
        return reject('name', `"${name}" is already used by ${takenBy}. Choose another name.`)
      }
    }
    const previousRaw =
      previousName === undefined ? undefined : rawEntrySchema.safeParse(servers[previousName])
    const entry = buildEntry(input, previousRaw?.success ? previousRaw.data : undefined)
    if (!entry.ok) return entry
    // Rebuild in order so a renamed server keeps its place in the file.
    const next: Record<string, unknown> = {}
    let placed = false
    for (const [key, value] of Object.entries(servers)) {
      if (key === previousName) {
        next[name] = entry.value
        placed = true
      } else {
        next[key] = value
      }
    }
    if (!placed) next[name] = entry.value
    const file: RawFile = { ...read.file, mcpServers: next }
    try {
      await writeRawFile(path, file)
    } catch {
      return reject('form', `Could not write ${path}.`)
    }
    return { ok: true, list: listFrom(path, file) }
  })
}

/** Remove one server from Copse's `mcp.json`. A name that is not there is a no-op. */
export function removeUserMcpServer(
  name: string,
  path: string = copseUserMcpConfigPath(),
): Promise<McpUserServerSaveResult> {
  return serialized(async () => {
    const read = await readRawFile(path)
    if (!read.ok) return reject('form', read.error)
    const servers = read.file.mcpServers ?? {}
    if (!Object.hasOwn(servers, name)) return { ok: true, list: listFrom(path, read.file) }
    const file: RawFile = {
      ...read.file,
      mcpServers: Object.fromEntries(Object.entries(servers).filter(([key]) => key !== name)),
    }
    try {
      await writeRawFile(path, file)
    } catch {
      return reject('form', `Could not write ${path}.`)
    }
    return { ok: true, list: listFrom(path, file) }
  })
}
