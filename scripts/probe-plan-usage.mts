#!/usr/bin/env node
/**
 * Probe Claude / Codex plan-usage endpoints through `@copse/plan-usage`, then
 * diff the raw JSON against the known schemas so new fields (Fable landed this
 * way) fail loudly instead of being silently ignored.
 *
 *   npm run probe:plan-usage
 *   npm run probe:plan-usage -- --provider claude
 *   npm run probe:plan-usage -- --fixture path/to/claude.json --provider claude
 *   npm run probe:plan-usage -- --json
 *
 * Exit codes:
 *   0 — fetch+parse ok, no unknown fields
 *   1 — unknown fields / enum values found (schema drift)
 *   2 — could not fetch or parse (auth / network / empty)
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  fetchClaudePlanUsage,
  fetchCodexPlanUsage,
  parseClaudeCredentialsJson,
  parseCodexAuthJson,
  CLAUDE_USAGE_SCHEMA,
  CODEX_USAGE_SCHEMA,
  findUnknownFields,
  type FetchLike,
  type PlanProviderId,
  type ProviderPlanResult,
  type UnknownFieldFinding,
} from '../packages/plan-usage/src/index.ts'

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
      if (value !== 'all' && value !== 'claude' && value !== 'codex') {
        throw new Error(`--provider must be all|claude|codex (got ${String(value)})`)
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

function discoverClaudeToken(): string | null {
  const fromEnv = process.env['CLAUDE_CODE_OAUTH_TOKEN']?.trim()
  if (fromEnv) return fromEnv
  const file = readJsonFile(join(homedir(), '.claude', '.credentials.json'))
  return parseClaudeCredentialsJson(file)
}

function discoverCodexAuth(): { accessToken: string; accountId: string | null } | null {
  const file = readJsonFile(join(homedir(), '.codex', 'auth.json'))
  return parseCodexAuthJson(file)
}

/** Capture the JSON body while still driving the real package fetch/parse path. */
function capturingFetch(inner: FetchLike, sink: { body: unknown }): FetchLike {
  return async (input, init) => {
    const response = await inner(input, init)
    const text = await response.text()
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

function fixtureFetch(body: unknown): FetchLike {
  const text = JSON.stringify(body)
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(text),
    })
}

interface ProviderProbeReport {
  provider: PlanProviderId
  parse: ProviderPlanResult
  unknownFields: UnknownFieldFinding[]
  raw: unknown
}

async function probeClaude(args: Args): Promise<ProviderProbeReport> {
  const sink: { body: unknown } = { body: null }
  let fetchImpl: FetchLike
  let token: string | null = 'fixture-token'

  if (args.fixture) {
    const body = JSON.parse(readFileSync(args.fixture, 'utf8')) as unknown
    fetchImpl = capturingFetch(fixtureFetch(body), sink)
  } else {
    token = discoverClaudeToken()
    fetchImpl = capturingFetch(globalThis.fetch.bind(globalThis), sink)
  }

  const parse = await fetchClaudePlanUsage(token, {
    fetch: fetchImpl,
    signal: AbortSignal.timeout(12_000),
  })
  const unknownFields =
    sink.body !== null && typeof sink.body === 'object'
      ? findUnknownFields(sink.body, CLAUDE_USAGE_SCHEMA)
      : []
  return { provider: 'claude', parse, unknownFields, raw: sink.body }
}

async function probeCodex(args: Args): Promise<ProviderProbeReport> {
  const sink: { body: unknown } = { body: null }
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
  const unknownFields =
    sink.body !== null && typeof sink.body === 'object'
      ? findUnknownFields(sink.body, CODEX_USAGE_SCHEMA)
      : []
  return { provider: 'codex', parse, unknownFields, raw: sink.body }
}

function printHuman(report: ProviderProbeReport, raw: boolean): void {
  console.log(`\n=== ${report.provider} ===`)
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
  --provider all|claude|codex   Which provider(s) to probe (default: all)
  --fixture <path.json>         Skip network; feed a saved payload (requires --provider claude|codex)
  --json                        Machine-readable report
  --raw                         Include raw provider JSON in the report
  --no-strict                   Exit 0 even when unknown fields are found
  --help                        Show this help

Exit 1 on schema drift (unknown keys/enums). Exit 2 when auth/fetch/parse fails.`)
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
    console.error('--fixture requires --provider claude|codex')
    return 2
  }

  const reports: ProviderProbeReport[] = []
  if (args.provider === 'all' || args.provider === 'claude') {
    reports.push(await probeClaude(args))
  }
  if (args.provider === 'all' || args.provider === 'codex') {
    reports.push(await probeCodex(args))
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
