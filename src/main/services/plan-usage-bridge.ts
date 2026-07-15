import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getPlanUsageSnapshot,
  orderClaudeTokenCandidates,
  parseCodexAuthJson,
  parseCursorSessionToken,
  parseHuggingFaceToken,
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
  const candidates = orderClaudeTokenCandidates({
    keychainJson: readKeychain(),
    credentialsJson: readJsonFile(join(home, '.claude', '.credentials.json')),
    envToken: env['CLAUDE_CODE_OAUTH_TOKEN'] ?? null,
  })

  const codexFile = readJsonFile(join(home, '.codex', 'auth.json'))
  const parsedCodex = parseCodexAuthJson(codexFile)

  const credentials: PlanUsageCredentials = {
    claudeOAuthTokens: candidates.map((c) => c.token),
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

/**
 * Host bridge around `@copse/plan-usage`. Always resolves — never rejects —
 * so Settings → Usage keeps showing the local ledger when plan fetch fails.
 */
export async function loadPlanUsageSnapshot(): Promise<PlanUsageSnapshot> {
  try {
    if (process.env[MOCK_ENV] === '1') return mockSnapshot()

    const credentials = discoverPlanUsageCredentials()
    return await getPlanUsageSnapshot(credentials, {
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.planUsage),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const checkedAt = new Date().toISOString()
    return {
      checkedAt,
      providers: [
        { status: 'error', provider: 'claude', message },
        { status: 'error', provider: 'codex', message },
        { status: 'error', provider: 'huggingface', message },
        { status: 'error', provider: 'cursor', message },
      ],
    }
  }
}
