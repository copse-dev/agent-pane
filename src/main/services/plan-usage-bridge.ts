import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  fetchClaudePlanUsageFromCredentials,
  getPlanUsageSnapshot,
  orderClaudeOAuthCredentials,
  parseCodexAuthJson,
  parseCursorSessionToken,
  parseHuggingFaceToken,
  type PlanProviderId,
  type PlanUsageCredentials,
  type PlanUsageSnapshot,
} from '@copse/plan-usage'
import { acpPlanProvider } from '@shared/acp.ts'
import { listEnabledAcpAgents } from './acp/acp-agent-registry.ts'
import { FETCH_TIMEOUTS } from './fetch-timeouts.ts'
import { hasApiKey, resolveApiKey } from './storage/settings.ts'
import { AsyncTtlCache } from './async-ttl-cache.ts'
import { firstNonEmptyString, nonEmptyStringOr } from '@shared/unknown-value.ts'

/** Env override for e2e / demos — skips network and credential discovery. */
const MOCK_ENV = 'COPSE_PLAN_USAGE_MOCK'

/** Re-fetch subscription plan windows at most this often (avoids provider rate limits). */
export const PLAN_USAGE_CACHE_TTL_MS = 5 * 60 * 1000

const planUsageCache = new AsyncTtlCache<string, PlanUsageSnapshot>({
  ttlMs: PLAN_USAGE_CACHE_TTL_MS,
  maxEntries: 1,
})

/** Drop cached plan usage (tests, or after credentials change). */
export function invalidatePlanUsageCache(): void {
  planUsageCache.clear()
}

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CURSOR_KEYCHAIN_SERVICE = 'cursor-access-token'

/**
 * Where the `claude` CLI keeps its OAuth credentials file.
 *
 * `CLAUDE_CONFIG_DIR` relocates the whole config directory, so the file sits
 * directly under it rather than under a nested `.claude` — the variable
 * *replaces* `~/.claude`, it does not reparent it. Anthropic documents the
 * override for Linux and Windows (macOS keeps credentials in the Keychain), but
 * it is honoured on every platform here: on macOS the Keychain candidate is
 * still preferred by `orderClaudeOAuthCredentials`, so respecting the override
 * costs a miss on a file that isn't there and gains the users who relocated
 * their config anyway.
 */
export function claudeCredentialsPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env['CLAUDE_CONFIG_DIR']?.trim()
  return configDir
    ? join(configDir, '.credentials.json')
    : join(home, '.claude', '.credentials.json')
}

/** Async `execFile` — never use Sync variants here; Keychain/sqlite probes run when
 * Settings → Usage opens and Sync would beachball the Electron main process on macOS. */
const execFileAsync = promisify(execFile)

async function runCommand(bin: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, [...args], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  return stdout
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** macOS Keychain payload written by `claude /login` (includes user:profile). */
export async function readClaudeKeychainCredentialsJson(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const raw = (
      await runCommand('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'])
    ).trim()
    return raw || null
  } catch {
    return null
  }
}

/** macOS Keychain JWT written by `cursor-agent` login. */
export async function readCursorKeychainAccessToken(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const raw = (
      await runCommand('security', ['find-generic-password', '-s', CURSOR_KEYCHAIN_SERVICE, '-w'])
    ).trim()
    return parseCursorSessionToken(raw)
  } catch {
    return null
  }
}

/** Candidate paths for Cursor IDE `state.vscdb` (ItemTable cursorAuth/accessToken). */
export function cursorStateDbPaths(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths: string[] = []
  if (process.platform === 'darwin') {
    paths.push(
      join(
        home,
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb',
      ),
    )
  } else if (process.platform === 'win32') {
    const appData = env['APPDATA']?.trim()
    if (appData) {
      paths.push(join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
    }
  } else {
    paths.push(join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'))
  }
  return paths
}

/**
 * Read `cursorAuth/accessToken` from Cursor's local SQLite state DB via the
 * `sqlite3` CLI (read-only). Returns null when sqlite3/DB/key are missing.
 */
export async function readCursorAccessTokenFromStateDb(dbPath: string): Promise<string | null> {
  if (!existsSync(dbPath)) return null
  try {
    const raw = (
      await runCommand('sqlite3', [
        dbPath,
        "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;",
      ])
    ).trim()
    return parseCursorSessionToken(raw)
  } catch {
    return null
  }
}

async function discoverHuggingFaceToken(
  home: string,
  env: NodeJS.ProcessEnv,
  resolveStored: () => string | null,
): Promise<string | undefined> {
  const fromStored = resolveStored()?.trim()
  if (fromStored) return fromStored
  const fromEnv = firstNonEmptyString(env['HF_TOKEN']?.trim(), env['HUGGINGFACE_API_KEY']?.trim())
  if (fromEnv) return fromEnv
  const hfHome = nonEmptyStringOr(env['HF_HOME']?.trim(), join(home, '.cache', 'huggingface'))
  return parseHuggingFaceToken(await readTextFile(join(hfHome, 'token'))) ?? undefined
}

async function discoverCursorSessionToken(
  home: string,
  env: NodeJS.ProcessEnv,
  readKeychain: () => Promise<string | null>,
  readStateDb: (dbPath: string) => Promise<string | null>,
): Promise<string | undefined> {
  const fromEnv = firstNonEmptyString(
    parseCursorSessionToken(env['CURSOR_SESSION_TOKEN'] ?? null),
    parseCursorSessionToken(env['WORKOS_CURSOR_SESSION_TOKEN'] ?? null),
  )
  if (fromEnv) return fromEnv
  const fromKeychain = await readKeychain()
  if (fromKeychain) return fromKeychain
  for (const dbPath of cursorStateDbPaths(home, env)) {
    const fromDb = await readStateDb(dbPath)
    if (fromDb) return fromDb
  }
  return undefined
}

const ALL_PLAN_PROVIDERS: ReadonlySet<PlanProviderId> = new Set([
  'claude',
  'codex',
  'huggingface',
  'cursor',
])

/**
 * The plan providers the user has set up in Settings → General, the only ones
 * whose sign-ins plan usage may read. Claude and Codex count once an enabled
 * Claude Code or Codex agent is registered; Cursor once an enabled Cursor agent
 * is registered or a Cursor key is saved; Hugging Face once a key is saved in
 * Copse. An environment variable alone does not confirm a provider.
 */
export function confirmedPlanUsageProviders(
  agents = listEnabledAcpAgents(),
  hasStoredKey: (provider: string) => boolean = hasApiKey,
): ReadonlySet<PlanProviderId> {
  const confirmed = new Set<PlanProviderId>()
  for (const agent of agents) {
    const plan = acpPlanProvider(agent)
    if (plan !== null) confirmed.add(plan)
    if (agent.id === 'cursor') confirmed.add('cursor')
  }
  if (hasStoredKey('cursor')) confirmed.add('cursor')
  if (hasStoredKey('huggingface')) confirmed.add('huggingface')
  return confirmed
}

const NOT_CONFIRMED_REASON: Record<PlanProviderId, string> = {
  claude: 'Set up Claude Code in Settings → General to show this plan’s usage.',
  codex: 'Set up Codex in Settings → General to show this plan’s usage.',
  huggingface: 'Save a Hugging Face key in Settings → General to show this plan’s usage.',
  cursor: 'Set up Cursor in Settings → General to show this plan’s usage.',
}

/**
 * Discover Claude / Codex / Hugging Face / Cursor tokens from Keychain, files,
 * and env. Only `providers` are looked up: nothing is read for the others.
 */
export async function discoverPlanUsageCredentials(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  readKeychain: () => Promise<string | null> = readClaudeKeychainCredentialsJson,
  resolveHuggingFaceStored: () => string | null = () => resolveApiKey('huggingface'),
  readCursorKeychain: () => Promise<string | null> = readCursorKeychainAccessToken,
  readCursorStateDb: (dbPath: string) => Promise<string | null> = readCursorAccessTokenFromStateDb,
  providers: ReadonlySet<PlanProviderId> = ALL_PLAN_PROVIDERS,
): Promise<PlanUsageCredentials> {
  const claudeCredentials = providers.has('claude')
    ? orderClaudeOAuthCredentials({
        keychainJson: await readKeychain(),
        credentialsJson: await readJsonFile(claudeCredentialsPath(home, env)),
        envToken: env['CLAUDE_CODE_OAUTH_TOKEN'] ?? null,
      })
    : []

  const codexFile = providers.has('codex')
    ? await readJsonFile(join(home, '.codex', 'auth.json'))
    : null
  const parsedCodex = parseCodexAuthJson(codexFile)

  const credentials: PlanUsageCredentials = {
    // Keep the flat token list for back-compat; `claudeCredentials` carries the
    // expiry so a lapsed token reads as "waiting on Claude Code", not a sign-in.
    claudeOAuthTokens: claudeCredentials.map((c) => c.accessToken),
    claudeCredentials: claudeCredentials.map((c) => ({
      accessToken: c.accessToken,
      expiresAt: c.expiresAt,
    })),
  }
  if (parsedCodex) {
    credentials.codex = {
      accessToken: parsedCodex.accessToken,
      accountId: parsedCodex.accountId,
    }
  }
  if (providers.has('huggingface')) {
    const hf = await discoverHuggingFaceToken(home, env, resolveHuggingFaceStored)
    if (hf) credentials.huggingfaceToken = hf
  }
  if (providers.has('cursor')) {
    const cursor = await discoverCursorSessionToken(
      home,
      env,
      readCursorKeychain,
      readCursorStateDb,
    )
    if (cursor) credentials.cursorSessionToken = cursor
  }
  return credentials
}

/** Replace each unconfirmed provider's row with a pointer to Settings → General. */
export function markUnconfirmedPlanProviders(
  snapshot: PlanUsageSnapshot,
  confirmed: ReadonlySet<PlanProviderId>,
): PlanUsageSnapshot {
  return {
    ...snapshot,
    providers: snapshot.providers.map((result) =>
      confirmed.has(result.provider)
        ? result
        : {
            status: 'unavailable',
            provider: result.provider,
            reason: NOT_CONFIRMED_REASON[result.provider],
          },
    ),
  }
}

function mockSnapshot(): PlanUsageSnapshot {
  const checkedAt = new Date().toISOString()
  return {
    checkedAt,
    providers: [
      {
        status: 'ok',
        provider: 'claude',
        usage: {
          provider: 'claude',
          plan: 'Weekly $99 / $100',
          windows: [
            {
              id: 'five_hour',
              label: '5-hour',
              usedPercent: 0,
              resetsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
              severity: 'normal',
              usedDollars: 0,
              limitDollars: 20,
            },
            {
              id: 'seven_day',
              label: 'Weekly',
              usedPercent: 99,
              resetsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
              severity: 'critical',
              usedDollars: 99,
              limitDollars: 100,
            },
            {
              id: 'seven_day_fable',
              label: 'Weekly Fable',
              usedPercent: 89,
              resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
              severity: 'warning',
            },
            {
              id: 'extra_usage',
              label: 'Extra usage',
              usedPercent: 10.58,
              resetsAt: null,
              unit: 'credits',
              usedCredits: 10_577,
              limitCredits: 100_000,
            },
          ],
          checkedAt,
        },
      },
      {
        status: 'ok',
        provider: 'codex',
        usage: {
          provider: 'codex',
          plan: 'plus (mock)',
          windows: [
            {
              id: 'primary',
              label: '5-hour',
              usedPercent: 11,
              resetsAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
            },
            {
              id: 'secondary',
              label: 'Weekly',
              usedPercent: 7,
              resetsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
            },
            {
              id: 'spend_control',
              label: 'Monthly credits',
              usedPercent: 6,
              resetsAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
              unit: 'credits',
              usedCredits: 972,
              limitCredits: 15_000,
            },
          ],
          checkedAt,
        },
      },
      {
        status: 'ok',
        provider: 'huggingface',
        usage: {
          provider: 'huggingface',
          plan: 'Inference Providers ($302 limit · included $2.00)',
          windows: [
            {
              id: 'inference_providers',
              label: 'Monthly inference',
              usedPercent: 12,
              resetsAt: new Date(Date.now() + 16 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ],
          checkedAt,
        },
      },
      {
        status: 'ok',
        provider: 'cursor',
        usage: {
          provider: 'cursor',
          plan: "You've used 2% of your included total usage · Hard limit $50",
          creditGrant: {
            remainingCents: 6703,
            totalCents: 10000,
            usedCents: 3297,
          },
          windows: [
            {
              id: 'total',
              label: 'Total included ($400 pool)',
              usedPercent: 2,
              resetsAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
            },
            {
              id: 'auto',
              label: 'First-party models',
              usedPercent: 3,
              resetsAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
            },
            {
              id: 'api',
              label: 'API (incl. ≥$400)',
              usedPercent: 0,
              resetsAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
            },
            {
              id: 'spend_limit',
              label: 'On-demand ($0 / $50)',
              usedPercent: 0,
              resetsAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ],
          checkedAt,
        },
      },
    ],
  }
}

function mockAuthErrorSnapshot(): PlanUsageSnapshot {
  const checkedAt = new Date().toISOString()
  return {
    checkedAt,
    providers: [
      {
        status: 'unavailable',
        provider: 'claude',
        reason:
          'Claude credentials were rejected. Re-run `claude /login` so Copse can read a fresh Claude OAuth login token.',
      },
      {
        status: 'ok',
        provider: 'codex',
        usage: {
          provider: 'codex',
          plan: 'prolite',
          windows: [
            {
              id: 'primary',
              label: 'Weekly',
              usedPercent: 1,
              resetsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ],
          checkedAt,
        },
      },
      {
        status: 'error',
        provider: 'huggingface',
        message: 'The operation was aborted due to timeout',
      },
      {
        status: 'unavailable',
        provider: 'cursor',
        reason:
          'Cursor session was rejected (expired WorkosCursorSessionToken). Re-sign in to Cursor or refresh CURSOR_SESSION_TOKEN from cursor.com cookies.',
      },
    ],
  }
}

/** Codex weekly window spent while the separate ChatPass pool still covers Astra. */
function mockCodexChatpassSnapshot(): PlanUsageSnapshot {
  const checkedAt = new Date().toISOString()
  const resetsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
  return {
    checkedAt,
    providers: [
      {
        status: 'ok',
        provider: 'codex',
        usage: {
          provider: 'codex',
          plan: 'pro',
          windows: [
            { id: 'primary', label: 'Weekly', usedPercent: 100, resetsAt },
            { id: 'chatpass_0', label: 'ChatPass Weekly', usedPercent: 0, resetsAt },
          ],
          modelAvailability: { 'gpt-6-astra': true },
          checkedAt,
        },
      },
    ],
  }
}

/**
 * A lapsed Claude access token, run through the real package path (it returns
 * before any network call) so the fixture shows the copy users actually see.
 */
async function mockClaudeTokenExpiredSnapshot(): Promise<PlanUsageSnapshot> {
  const claude = await fetchClaudePlanUsageFromCredentials([
    { accessToken: 'sk-ant-oat01-mock', expiresAt: 0 },
  ])
  return { checkedAt: new Date().toISOString(), providers: [claude] }
}

async function fetchPlanUsageSnapshotUncached(): Promise<PlanUsageSnapshot> {
  try {
    if (process.env[MOCK_ENV] === '1') return mockSnapshot()
    if (process.env[MOCK_ENV] === 'auth-errors') return mockAuthErrorSnapshot()
    if (process.env[MOCK_ENV] === 'codex-chatpass') return mockCodexChatpassSnapshot()
    if (process.env[MOCK_ENV] === 'claude-token-expired')
      return await mockClaudeTokenExpiredSnapshot()
    // The mock's plans, filtered by the real Settings → General confirmation.
    if (process.env[MOCK_ENV] === 'confirmed-only')
      return markUnconfirmedPlanProviders(mockSnapshot(), confirmedPlanUsageProviders())

    // Read only the sign-ins of providers set up in Settings → General. With
    // none, nothing is read and every row says where to set one up.
    const confirmed = confirmedPlanUsageProviders()
    const credentials = await discoverPlanUsageCredentials(
      homedir(),
      process.env,
      readClaudeKeychainCredentialsJson,
      () => resolveApiKey('huggingface'),
      readCursorKeychainAccessToken,
      readCursorAccessTokenFromStateDb,
      confirmed,
    )
    const snapshot = await getPlanUsageSnapshot(credentials, {
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.planUsage),
    })
    return markUnconfirmedPlanProviders(snapshot, confirmed)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const checkedAt = new Date().toISOString()
    return {
      checkedAt,
      providers: [],
      error: `Plan usage refresh failed before provider checks: ${message}`,
    }
  }
}

let fetchPlanUsageSnapshot = fetchPlanUsageSnapshotUncached

/** Replace the network-backed loader for deterministic cache tests. */
export function setPlanUsageSnapshotFetcherForTest(
  fetcher: (() => Promise<PlanUsageSnapshot>) | null,
): void {
  fetchPlanUsageSnapshot = fetcher ?? fetchPlanUsageSnapshotUncached
  invalidatePlanUsageCache()
}

/**
 * Host bridge around `@copse/plan-usage`. Always resolves — never rejects —
 * so Settings → Usage keeps showing the local ledger when plan fetch fails.
 */
export async function loadPlanUsageSnapshot(options?: {
  force?: boolean
}): Promise<PlanUsageSnapshot> {
  // Keyed by what is set up, so confirming or removing a provider fetches fresh
  // instead of serving the previous snapshot for up to five minutes.
  const key = `plan-usage:${[...confirmedPlanUsageProviders()].sort().join(',')}`
  return planUsageCache.get(key, () => fetchPlanUsageSnapshot(), {
    force: options?.force === true,
  })
}
