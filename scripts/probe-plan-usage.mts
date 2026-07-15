#!/usr/bin/env node
/**
 * Probe Claude / Codex / Hugging Face / Cursor plan-usage endpoints through
 * `@copse/plan-usage`, then diff the raw JSON against the known schemas so
 * new fields fail loudly instead of being silently ignored.
 *
 *   npm run probe:plan-usage
 *   npm run probe:plan-usage -- --provider claude
 *   npm run probe:plan-usage -- --provider cursor
 *   npm run probe:plan-usage -- --fixture path/to/cursor.json --provider cursor
 *   npm run probe:plan-usage -- --json
 *
 * Exit codes:
 *   0 — fetch+parse ok, no unknown fields
 *   1 — unknown fields / enum values found (schema drift)
 *   2 — could not fetch or parse (auth / network / empty)
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  fetchClaudePlanUsageFromCandidates,
  fetchCodexPlanUsage,
  fetchCursorPlanUsage,
  fetchHuggingFacePlanUsage,
  orderClaudeTokenCandidates,
  parseCodexAuthJson,
  parseCursorSessionToken,
  parseHuggingFaceToken,
  CLAUDE_USAGE_SCHEMA,
  CODEX_USAGE_SCHEMA,
  CURSOR_PERIOD_USAGE_SCHEMA,
  HUGGINGFACE_USAGE_SCHEMA,
  findUnknownFields,
  type FetchLike,
  type PlanProviderId,
  type ProviderPlanResult,
  type SchemaNode,
  type UnknownFieldFinding,
} from '../packages/plan-usage/src/index.ts'

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CURSOR_KEYCHAIN_SERVICE = 'cursor-access-token'

function readClaudeKeychainCredentialsJson(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim()
    return raw || null
  } catch {
    return null
  }
}

function readCursorKeychainAccessToken(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', CURSOR_KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim()
    return parseCursorSessionToken(raw)
  } catch {
    return null
  }
}

function readCursorAccessTokenFromStateDb(): string | null {
  const home = homedir()
  const candidates =
    process.platform === 'darwin'
      ? [
          join(
            home,
            'Library',
            'Application Support',
            'Cursor',
            'User',
            'globalStorage',
            'state.vscdb',
          ),
        ]
      : process.platform === 'win32'
        ? process.env['APPDATA']
          ? [join(process.env['APPDATA'], 'Cursor', 'User', 'globalStorage', 'state.vscdb')]
          : []
        : [join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')]

  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue
    try {
      const raw = execFileSync(
        'sqlite3',
        [dbPath, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;"],
        { encoding: 'utf8', timeout: 5_000 },
      ).trim()
      const token = parseCursorSessionToken(raw)
      if (token) return token
    } catch {
      // try next
    }
  }
  return null
}

interface Args {
  provider: 'all' | PlanProviderId
  fixture: string | null
  json: boolean
  raw: boolean
  strict: boolean
  help: boolean
}

const PROVIDERS: ReadonlyArray<'all' | PlanProviderId> = [
  'all',
  'claude',
  'codex',
  'huggingface',
  'cursor',
]

function parseArgs(argv: string[]): Args {
  const args: Args = {
    provider: 'all',
    fixture: null,
    json: false,
    raw: false,
    strict: true,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--json') args.json = true
    else if (arg === '--raw') args.raw = true
    else if (arg === '--no-strict') args.strict = false
    else if (arg === '--provider') {
      const value = argv[++i]
      if (!PROVIDERS.includes(value as (typeof PROVIDERS)[number])) {
        throw new Error(
          `--provider must be all|claude|codex|huggingface|cursor (got ${String(value)})`,
        )
      }
      args.provider = value as Args['provider']
    } else if (arg === '--fixture') {
      const value = argv[++i]
      if (!value) throw new Error('--fixture requires a path')
      args.fixture = value
    } else {
      throw new Error(`unknown argument: ${String(arg)}`)
    }
  }
  return args
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function discoverClaudeCandidates(): ReturnType<typeof orderClaudeTokenCandidates> {
  return orderClaudeTokenCandidates({
    keychainJson: readClaudeKeychainCredentialsJson(),
    credentialsJson: readJsonFile(join(homedir(), '.claude', '.credentials.json')),
    envToken: process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? null,
  })
}

function discoverCodexAuth(): { accessToken: string; accountId: string | null } | null {
  const file = readJsonFile(join(homedir(), '.codex', 'auth.json'))
  return parseCodexAuthJson(file)
}

/** Copse userData dir (same layout as e2e helpers / app-init). */
function copseUserDataDir(): string {
  const override = process.env['COPSE_PANEL_USER_DATA']?.trim()
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'copse-panel')
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']?.trim()
    return appData ? join(appData, 'copse-panel') : join(homedir(), 'copse-panel')
  }
  return join(homedir(), '.config', 'copse-panel')
}

/**
 * Read `apiKey.huggingface` from Copse `settings.json` without Electron.
 * Only plaintext (`plain: true`) records are usable here — OS-encrypted keys
 * need Electron safeStorage (available in the app, not this CLI).
 */
function readHuggingFaceTokenFromSettings(): {
  token: string | null
  encryptedPresent: boolean
} {
  const settings = readJsonFile(join(copseUserDataDir(), 'settings.json'))
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { token: null, encryptedPresent: false }
  }
  const root = settings as Record<string, unknown>
  const apiKeyRoot = root['apiKey']
  const nested =
    apiKeyRoot && typeof apiKeyRoot === 'object' && !Array.isArray(apiKeyRoot)
      ? (apiKeyRoot as Record<string, unknown>)['huggingface']
      : undefined
  const flat = root['apiKey.huggingface']
  const record = nested ?? flat
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { token: null, encryptedPresent: false }
  }
  const stored = record as Record<string, unknown>
  const enc = stored['enc']
  if (typeof enc !== 'string' || !enc) {
    return { token: null, encryptedPresent: false }
  }
  if (stored['plain'] === true) {
    try {
      const token = parseHuggingFaceToken(Buffer.from(enc, 'base64').toString('utf8'))
      return { token, encryptedPresent: false }
    } catch {
      return { token: null, encryptedPresent: false }
    }
  }
  return { token: null, encryptedPresent: true }
}

function discoverHuggingFaceToken(): {
  token: string | null
  settingsEncrypted: boolean
} {
  const fromEnv =
    process.env['HF_TOKEN']?.trim() || process.env['HUGGINGFACE_API_KEY']?.trim() || null
  if (fromEnv) return { token: fromEnv, settingsEncrypted: false }

  const home = process.env['HF_HOME']?.trim() || join(homedir(), '.cache', 'huggingface')
  try {
    const fromFile = parseHuggingFaceToken(readFileSync(join(home, 'token'), 'utf8'))
    if (fromFile) return { token: fromFile, settingsEncrypted: false }
  } catch {
    // continue
  }

  const fromSettings = readHuggingFaceTokenFromSettings()
  return {
    token: fromSettings.token,
    settingsEncrypted: fromSettings.encryptedPresent,
  }
}

function discoverCursorSessionToken(): string | null {
  return (
    parseCursorSessionToken(process.env['CURSOR_SESSION_TOKEN'] ?? null) ||
    parseCursorSessionToken(process.env['WORKOS_CURSOR_SESSION_TOKEN'] ?? null) ||
    readCursorKeychainAccessToken() ||
    readCursorAccessTokenFromStateDb()
  )
}

/** Capture the JSON body while still driving the real package fetch/parse path. */
function capturingFetch(inner: FetchLike, sink: { body: unknown; status: number }): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init)
    const text = await response.text()
    sink.status = response.status
    try {
      sink.body = JSON.parse(text) as unknown
    } catch {
      sink.body = text
    }
    return {
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(text),
    }
  }
}

function fixtureFetch(body: unknown, status = 200): FetchLike {
  const text = JSON.stringify(body)
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    })
}

/** Cursor posts to period-usage + hard-limit; keep the period body for schema diff. */
function cursorCapturingFetch(
  inner: FetchLike,
  periodSink: { body: unknown; status: number },
): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init)
    const text = await response.text()
    const url = input
    if (url.includes('get-current-period-usage')) {
      periodSink.status = response.status
      try {
        periodSink.body = JSON.parse(text) as unknown
      } catch {
        periodSink.body = text
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(text),
    }
  }
}

interface ProviderProbeReport {
  provider: PlanProviderId
  parse: ProviderPlanResult
  unknownFields: UnknownFieldFinding[]
  raw: unknown
  httpStatus: number | null
  claudeSources?: string
}

function unknownFieldsForOkParse(
  parse: ProviderPlanResult,
  httpStatus: number,
  body: unknown,
  schema: SchemaNode,
): UnknownFieldFinding[] {
  if (parse.status !== 'ok' || httpStatus < 200 || httpStatus >= 300) return []
  if (body === null || typeof body !== 'object') return []
  return findUnknownFields(body, schema)
}

async function probeClaude(args: Args): Promise<ProviderProbeReport> {
  const sink: { body: unknown; status: number } = { body: null, status: 0 }
  let fetchImpl: FetchLike
  let tokens: Array<string | null> = ['fixture-token']
  let claudeSources: string | undefined

  if (args.fixture) {
    const body = JSON.parse(readFileSync(args.fixture, 'utf8')) as unknown
    fetchImpl = capturingFetch(fixtureFetch(body), sink)
  } else {
    const candidates = discoverClaudeCandidates()
    tokens = candidates.map((c) => c.token)
    claudeSources = candidates.length === 0 ? '(none)' : candidates.map((c) => c.source).join(' → ')
    fetchImpl = capturingFetch(globalThis.fetch.bind(globalThis), sink)
  }

  const parse = await fetchClaudePlanUsageFromCandidates(tokens, {
    fetch: fetchImpl,
    signal: AbortSignal.timeout(12_000),
  })
  return {
    provider: 'claude',
    parse,
    unknownFields: unknownFieldsForOkParse(parse, sink.status, sink.body, CLAUDE_USAGE_SCHEMA),
    raw: sink.body,
    httpStatus: sink.status || null,
    ...(claudeSources ? { claudeSources } : {}),
  }
}

async function probeCodex(args: Args): Promise<ProviderProbeReport> {
  const sink: { body: unknown; status: number } = { body: null, status: 0 }
  let fetchImpl: FetchLike
  let auth: { accessToken: string | null; accountId?: string | null } = {
    accessToken: 'fixture-token',
  }

  if (args.fixture) {
    const body = JSON.parse(readFileSync(args.fixture, 'utf8')) as unknown
    fetchImpl = capturingFetch(fixtureFetch(body), sink)
  } else {
    const discovered = discoverCodexAuth()
    auth = discovered ?? { accessToken: null }
    fetchImpl = capturingFetch(globalThis.fetch.bind(globalThis), sink)
  }

  const parse = await fetchCodexPlanUsage(auth, {
    fetch: fetchImpl,
    signal: AbortSignal.timeout(12_000),
  })
  return {
    provider: 'codex',
    parse,
    unknownFields: unknownFieldsForOkParse(parse, sink.status, sink.body, CODEX_USAGE_SCHEMA),
    raw: sink.body,
    httpStatus: sink.status || null,
  }
}

async function probeHuggingFace(args: Args): Promise<ProviderProbeReport> {
  const sink: { body: unknown; status: number } = { body: null, status: 0 }
  let fetchImpl: FetchLike
  let token: string | null = 'fixture-token'
  let settingsEncrypted = false

  if (args.fixture) {
    const body = JSON.parse(readFileSync(args.fixture, 'utf8')) as unknown
    fetchImpl = capturingFetch(fixtureFetch(body), sink)
  } else {
    const discovered = discoverHuggingFaceToken()
    token = discovered.token
    settingsEncrypted = discovered.settingsEncrypted
    fetchImpl = capturingFetch(globalThis.fetch.bind(globalThis), sink)
  }

  let parse = await fetchHuggingFacePlanUsage(token, {
    fetch: fetchImpl,
    signal: AbortSignal.timeout(12_000),
  })
  if (!args.fixture && !token && settingsEncrypted && parse.status === 'unavailable') {
    parse = {
      status: 'unavailable',
      provider: 'huggingface',
      reason:
        'Copse Settings has a Hugging Face key, but it is OS-encrypted (Electron safeStorage) and this CLI cannot decrypt it. Settings → Usage in the app already works. To probe from the shell: `export HF_TOKEN=…` or run `hf auth login`.',
    }
  }
  return {
    provider: 'huggingface',
    parse,
    unknownFields: unknownFieldsForOkParse(parse, sink.status, sink.body, HUGGINGFACE_USAGE_SCHEMA),
    raw: sink.body,
    httpStatus: sink.status || null,
  }
}

async function probeCursor(args: Args): Promise<ProviderProbeReport> {
  const periodSink: { body: unknown; status: number } = { body: null, status: 0 }
  let fetchImpl: FetchLike
  let token: string | null = 'user_01fixture%3A%3Afake.jwt.token'

  if (args.fixture) {
    const body = JSON.parse(readFileSync(args.fixture, 'utf8')) as unknown
    const hardLimitBody = { hardLimit: 50 }
    fetchImpl = cursorCapturingFetch(async (input) => {
      const payload = input.includes('get-hard-limit') ? hardLimitBody : body
      return fixtureFetch(payload)(input)
    }, periodSink)
  } else {
    token = discoverCursorSessionToken()
    fetchImpl = cursorCapturingFetch(globalThis.fetch.bind(globalThis), periodSink)
  }

  const parse = await fetchCursorPlanUsage(token, {
    fetch: fetchImpl,
    signal: AbortSignal.timeout(12_000),
  })
  return {
    provider: 'cursor',
    parse,
    unknownFields: unknownFieldsForOkParse(
      parse,
      periodSink.status,
      periodSink.body,
      CURSOR_PERIOD_USAGE_SCHEMA,
    ),
    raw: periodSink.body,
    httpStatus: periodSink.status || null,
  }
}

function printHuman(report: ProviderProbeReport, raw: boolean): void {
  console.log(`\n=== ${report.provider} ===`)
  if (report.claudeSources) {
    console.log('token sources tried:', report.claudeSources)
  }
  console.log('parse:', JSON.stringify(report.parse, null, 2))
  if (report.unknownFields.length === 0) {
    console.log('unknown fields: (none)')
  } else {
    console.log(`unknown fields (${String(report.unknownFields.length)}):`)
    for (const finding of report.unknownFields) {
      console.log(`  - [${finding.kind}] ${finding.path}: ${finding.detail}`)
      if (finding.sample !== undefined) {
        console.log(`      sample: ${finding.sample}`)
      }
    }
  }
  if (raw) {
    console.log('raw:', JSON.stringify(report.raw, null, 2))
  }
}

function usage(): void {
  console.log(`Usage: npm run probe:plan-usage -- [options]

Options:
  --provider all|claude|codex|huggingface|cursor
                              Which provider(s) to probe (default: all)
  --fixture <path.json>         Skip network; feed a saved payload (requires --provider)
  --json                        Machine-readable report
  --raw                         Include raw provider JSON in the report
  --no-strict                   Exit 0 even when unknown fields are found
  --help                        Show this help

Exit 1 on schema drift (unknown keys/enums). Exit 2 when auth/fetch/parse fails.

Claude auth order (macOS): Keychain "Claude Code-credentials" →
~/.claude/.credentials.json → CLAUDE_CODE_OAUTH_TOKEN.

Hugging Face: HF_TOKEN / HUGGINGFACE_API_KEY → ~/.cache/huggingface/token
→ plaintext Copse Settings key. OS-encrypted Settings keys work in the app
only (this CLI cannot use Electron safeStorage).

Cursor: CURSOR_SESSION_TOKEN / WORKOS_CURSOR_SESSION_TOKEN → macOS Keychain
"cursor-access-token" → Cursor IDE state.vscdb (cursorAuth/accessToken).
Posts get-current-period-usage (+ get-hard-limit) with Origin: https://cursor.com.`)
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    usage()
    return 2
  }
  if (args.help) {
    usage()
    return 0
  }
  if (args.fixture && args.provider === 'all') {
    console.error('--fixture requires --provider claude|codex|huggingface|cursor')
    return 2
  }

  const reports: ProviderProbeReport[] = []
  if (args.provider === 'all' || args.provider === 'claude') {
    reports.push(await probeClaude(args))
  }
  if (args.provider === 'all' || args.provider === 'codex') {
    reports.push(await probeCodex(args))
  }
  if (args.provider === 'all' || args.provider === 'huggingface') {
    reports.push(await probeHuggingFace(args))
  }
  if (args.provider === 'all' || args.provider === 'cursor') {
    reports.push(await probeCursor(args))
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          reports: reports.map((r) => ({
            provider: r.provider,
            parse: r.parse,
            unknownFields: r.unknownFields,
            ...(r.claudeSources ? { claudeSources: r.claudeSources } : {}),
            ...(args.raw ? { raw: r.raw } : {}),
          })),
        },
        null,
        2,
      ),
    )
  } else {
    for (const report of reports) printHuman(report, args.raw)
  }

  const fetchFailed = reports.some(
    (r) => r.parse.status === 'error' || r.parse.status === 'unavailable',
  )
  const hasUnknown = reports.some((r) => r.unknownFields.length > 0)

  if (hasUnknown && args.strict) return 1
  if (fetchFailed && !args.fixture) return 2
  return 0
}

const code = await main()
process.exitCode = code
