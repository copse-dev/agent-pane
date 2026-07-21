import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getPlanUsageSnapshot,
  orderClaudeOAuthCredentials,
  parseCodexAuthJson,
  parseCursorSessionToken,
  parseHuggingFaceToken,
  type ClaudeRefreshedToken,
  type PlanUsageCredentials,
  type PlanUsageSnapshot,
} from '@copse/plan-usage'
import { FETCH_TIMEOUTS } from './fetch-timeouts.ts'
import { resolveApiKey } from './storage/settings.ts'

/** Env override for e2e / demos — skips network and credential discovery. */
const MOCK_ENV = 'COPSE_PLAN_USAGE_MOCK'

const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CURSOR_KEYCHAIN_SERVICE = 'cursor-access-token'

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** macOS Keychain payload written by `claude /login` (includes user:profile). */
export function readClaudeKeychainCredentialsJson(): string | null {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge refreshed tokens into the existing credential JSON, preserving every
 * other field (`scopes`, `subscriptionType`, …) exactly as Claude Code wrote
 * it. Returns `null` when the payload isn't the shape we expect, so we never
 * clobber an unfamiliar credential store.
 */
export function updateClaudeOAuthJson(
  rawJson: string | null,
  refreshed: ClaudeRefreshedToken,
): string | null {
  if (!rawJson) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const oauth = parsed['claudeAiOauth']
  if (!isRecord(oauth)) return null
  oauth['accessToken'] = refreshed.accessToken
  if (refreshed.refreshToken) oauth['refreshToken'] = refreshed.refreshToken
  if (refreshed.expiresAt !== null) oauth['expiresAt'] = refreshed.expiresAt
  return JSON.stringify(parsed)
}

/** The account (`-a`) on the Keychain item, needed to update it in place. */
function readClaudeKeychainAccount(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    // Attributes only (no `-w`/`-g`), so the password never hits our buffer.
    const attrs = execFileSync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE],
      { encoding: 'utf8', timeout: 5_000 },
    )
    const match = /"acct"<blob>="([^"]*)"/.exec(attrs)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** Update the `claude /login` Keychain item in place with a refreshed payload. */
export function writeClaudeKeychainCredentialsJson(json: string): void {
  if (process.platform !== 'darwin') return
  const account = readClaudeKeychainAccount() ?? process.env['USER'] ?? ''
  execFileSync(
    'security',
    ['add-generic-password', '-U', '-s', CLAUDE_KEYCHAIN_SERVICE, '-a', account, '-w', json],
    { timeout: 5_000 },
  )
}

/** Atomic, owner-only write so a concurrent reader never sees a half-written file. */
function atomicWriteFile(path: string, data: string): void {
  const tmp = `${path}.copse-${String(process.pid)}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Persist a refreshed Claude token back to the store it came from, mirroring
 * what the `claude` CLI does on its own refresh so both stay in sync. Rotated
 * refresh tokens must be saved or the next refresh fails. Best-effort — any
 * failure (Keychain ACL prompt denied, read-only FS) is swallowed; the fresh
 * in-memory token still served the current fetch.
 */
export function persistRefreshedClaudeToken(
  source: string | undefined,
  refreshed: ClaudeRefreshedToken,
  home = homedir(),
  readKeychain: () => string | null = readClaudeKeychainCredentialsJson,
  writeKeychain: (json: string) => void = writeClaudeKeychainCredentialsJson,
): void {
  try {
    if (source === 'credentials.json') {
      const path = join(home, '.claude', '.credentials.json')
      const next = updateClaudeOAuthJson(readTextFile(path), refreshed)
      if (next) atomicWriteFile(path, next)
      return
    }
    if (source === 'keychain') {
      const next = updateClaudeOAuthJson(readKeychain(), refreshed)
      if (next) writeKeychain(next)
    }
    // 'env' / unknown: nothing to persist (env is process-scoped).
  } catch {
    // Swallow — see doc comment.
  }
}

/** macOS Keychain JWT written by `cursor-agent` login. */
export function readCursorKeychainAccessToken(): string | null {
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
export function readCursorAccessTokenFromStateDb(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null
  try {
    const raw = execFileSync(
      'sqlite3',
      [dbPath, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;"],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim()
    return parseCursorSessionToken(raw)
  } catch {
    return null
  }
}

function discoverHuggingFaceToken(
  home: string,
  env: NodeJS.ProcessEnv,
  resolveStored: () => string | null,
): string | undefined {
  const fromStored = resolveStored()?.trim()
  if (fromStored) return fromStored
  const fromEnv = env['HF_TOKEN']?.trim() || env['HUGGINGFACE_API_KEY']?.trim() || undefined
  if (fromEnv) return fromEnv
  const hfHome = env['HF_HOME']?.trim() || join(home, '.cache', 'huggingface')
  return parseHuggingFaceToken(readTextFile(join(hfHome, 'token'))) ?? undefined
}

function discoverCursorSessionToken(
  home: string,
  env: NodeJS.ProcessEnv,
  readKeychain: () => string | null,
  readStateDb: (dbPath: string) => string | null,
): string | undefined {
  const fromEnv =
    parseCursorSessionToken(env['CURSOR_SESSION_TOKEN'] ?? null) ||
    parseCursorSessionToken(env['WORKOS_CURSOR_SESSION_TOKEN'] ?? null)
  if (fromEnv) return fromEnv
  const fromKeychain = readKeychain()
  if (fromKeychain) return fromKeychain
  for (const dbPath of cursorStateDbPaths(home, env)) {
    const fromDb = readStateDb(dbPath)
    if (fromDb) return fromDb
  }
  return undefined
}

/** Discover Claude / Codex / Hugging Face / Cursor tokens from Keychain, files, and env. */
export function discoverPlanUsageCredentials(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  readKeychain: () => string | null = readClaudeKeychainCredentialsJson,
  resolveHuggingFaceStored: () => string | null = () => resolveApiKey('huggingface'),
  readCursorKeychain: () => string | null = readCursorKeychainAccessToken,
  readCursorStateDb: (dbPath: string) => string | null = readCursorAccessTokenFromStateDb,
): PlanUsageCredentials {
  const claudeCredentials = orderClaudeOAuthCredentials({
    keychainJson: readKeychain(),
    credentialsJson: readJsonFile(join(home, '.claude', '.credentials.json')),
    envToken: env['CLAUDE_CODE_OAUTH_TOKEN'] ?? null,
  })

  const codexFile = readJsonFile(join(home, '.codex', 'auth.json'))
  const parsedCodex = parseCodexAuthJson(codexFile)

  const credentials: PlanUsageCredentials = {
    // Keep the flat token list for back-compat; `claudeCredentials` carries the
    // refresh tokens the fetch needs to self-heal an expired access token.
    claudeOAuthTokens: claudeCredentials.map((c) => c.accessToken),
    claudeCredentials: claudeCredentials.map((c) => ({
      accessToken: c.accessToken,
      refreshToken: c.refreshToken,
      expiresAt: c.expiresAt,
      source: c.source,
    })),
    onClaudeTokenRefreshed: (credential, refreshed) => {
      persistRefreshedClaudeToken(credential.source, refreshed, home, readKeychain)
    },
  }
  if (parsedCodex) {
    credentials.codex = {
      accessToken: parsedCodex.accessToken,
      accountId: parsedCodex.accountId,
    }
  }
  const hf = discoverHuggingFaceToken(home, env, resolveHuggingFaceStored)
  if (hf) credentials.huggingfaceToken = hf
  const cursor = discoverCursorSessionToken(home, env, readCursorKeychain, readCursorStateDb)
  if (cursor) credentials.cursorSessionToken = cursor
  return credentials
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
          plan: 'Extra usage £55.25 / £50 (disabled)',
          windows: [
            {
              id: 'five_hour',
              label: '5-hour (inactive)',
              usedPercent: 0,
              resetsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
              severity: 'normal',
            },
            {
              id: 'seven_day',
              label: 'Weekly',
              usedPercent: 99,
              resetsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
              severity: 'critical',
            },
            {
              id: 'seven_day_fable',
              label: 'Weekly Fable (inactive)',
              usedPercent: 89,
              resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
              severity: 'warning',
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

/**
 * Host bridge around `@copse/plan-usage`. Always resolves — never rejects —
 * so Settings → Usage keeps showing the local ledger when plan fetch fails.
 */
export async function loadPlanUsageSnapshot(): Promise<PlanUsageSnapshot> {
  try {
    if (process.env[MOCK_ENV] === '1') return mockSnapshot()
    if (process.env[MOCK_ENV] === 'auth-errors') return mockAuthErrorSnapshot()

    const credentials = discoverPlanUsageCredentials()
    return await getPlanUsageSnapshot(credentials, {
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.planUsage),
    })
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
