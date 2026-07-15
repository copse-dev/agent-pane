#!/usr/bin/env node
/**
 * Probe Claude / Codex / Hugging Face plan-usage endpoints through
 * `@copse/plan-usage`, then diff the raw JSON against the known schemas so
 * new fields (Fable landed this way) fail loudly instead of being silently
 * ignored.
 *
 *   npm run probe:plan-usage
 *   npm run probe:plan-usage -- --provider claude
 *   npm run probe:plan-usage -- --provider huggingface
 *   npm run probe:plan-usage -- --fixture path/to/claude.json --provider claude
 *   npm run probe:plan-usage -- --json
 *
 * Exit codes:
 *   0 — fetch+parse ok, no unknown fields
 *   1 — unknown fields / enum values found (schema drift)
 *   2 — could not fetch or parse (auth / network / empty)
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  fetchClaudePlanUsageFromCandidates,
  fetchCodexPlanUsage,
  fetchHuggingFacePlanUsage,
  orderClaudeTokenCandidates,
  parseCodexAuthJson,
  parseHuggingFaceToken,
  CLAUDE_USAGE_SCHEMA,
  CODEX_USAGE_SCHEMA,
  HUGGINGFACE_USAGE_SCHEMA,
  findUnknownFields,
  type FetchLike,
  type PlanProviderId,
  type ProviderPlanResult,
  type SchemaNode,
  type UnknownFieldFinding,
} from '../packages/plan-usage/src/index.ts'

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'

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

interface Args {
  provider: 'all' | PlanProviderId
  fixture: string | null
  json: boolean
  raw: boolean
  strict: boolean
  help: boolean
}

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
      if (value !== 'all' && value !== 'claude' && value !== 'codex' && value !== 'huggingface') {
        throw new Error(`--provider must be all|claude|codex|huggingface (got ${String(value)})`)
      }
      args.provider = value
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

/**
 * Prefer Keychain (`claude /login`) → credentials.json → env. Env setup-tokens
 * lack `user:profile` and 403; candidates are tried until one succeeds.
 */
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

function discoverHuggingFaceToken(): string | null {
  const fromEnv =
    process.env['HF_TOKEN']?.trim() || process.env['HUGGINGFACE_API_KEY']?.trim() || null
  if (fromEnv) return fromEnv
  const home = process.env['HF_HOME']?.trim() || join(homedir(), '.cache', 'huggingface')
  try {
    return parseHuggingFaceToken(readFileSync(join(home, 'token'), 'utf8'))
  } catch {
    return null
  }
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
  // Only schema-diff successful usage payloads. Error bodies (403/401 JSON)
  // would otherwise flood the report with type/error/request_id noise.
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

  if (args.fixture) {
    const body = JSON.parse(readFileSync(args.fixture, 'utf8')) as unknown
    fetchImpl = capturingFetch(fixtureFetch(body), sink)
  } else {
    token = discoverHuggingFaceToken()
    fetchImpl = capturingFetch(globalThis.fetch.bind(globalThis), sink)
  }

  const parse = await fetchHuggingFacePlanUsage(token, {
    fetch: fetchImpl,
    signal: AbortSignal.timeout(12_000),
  })
  return {
    provider: 'huggingface',
    parse,
    unknownFields: unknownFieldsForOkParse(parse, sink.status, sink.body, HUGGINGFACE_USAGE_SCHEMA),
    raw: sink.body,
    httpStatus: sink.status || null,
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
    }
  }
  if (raw) {
    console.log('raw:', JSON.stringify(report.raw, null, 2))
  }
}

function usage(): void {
  console.log(`Usage: npm run probe:plan-usage -- [options]

Options:
  --provider all|claude|codex|huggingface
                              Which provider(s) to probe (default: all)
  --fixture <path.json>         Skip network; feed a saved payload (requires --provider)
  --json                        Machine-readable report
  --raw                         Include raw provider JSON in the report
  --no-strict                   Exit 0 even when unknown fields are found
  --help                        Show this help

Exit 1 on schema drift (unknown keys/enums). Exit 2 when auth/fetch/parse fails.

Claude auth order (macOS): Keychain "Claude Code-credentials" →
~/.claude/.credentials.json → CLAUDE_CODE_OAUTH_TOKEN. Unset the env var if
it came from \`claude setup-token\` (inference-only; 403s without user:profile).

Hugging Face: HF_TOKEN / HUGGINGFACE_API_KEY → ~/.cache/huggingface/token
(\`hf auth login\`). Endpoint is personal billing usage-v2 for the current UTC month.`)
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
    console.error('--fixture requires --provider claude|codex|huggingface')
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
