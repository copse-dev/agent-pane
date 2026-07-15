import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getPlanUsageSnapshot,
  parseClaudeCredentialsJson,
  parseCodexAuthJson,
  type PlanUsageCredentials,
  type PlanUsageSnapshot,
} from '@copse/plan-usage'
import { FETCH_TIMEOUTS } from './fetch-timeouts.ts'

/** Env override for e2e / demos — skips network and credential discovery. */
const MOCK_ENV = 'COPSE_PLAN_USAGE_MOCK'

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** Discover Claude / Codex tokens from env + local CLI credential files. */
export function discoverPlanUsageCredentials(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): PlanUsageCredentials {
  const fromEnv = env['CLAUDE_CODE_OAUTH_TOKEN']?.trim()
  const claudeFile = readJsonFile(join(home, '.claude', '.credentials.json'))
  const claudeOAuthToken = fromEnv || parseClaudeCredentialsJson(claudeFile)

  const codexFile = readJsonFile(join(home, '.codex', 'auth.json'))
  const parsedCodex = parseCodexAuthJson(codexFile)

  const credentials: PlanUsageCredentials = {}
  if (claudeOAuthToken) credentials.claudeOAuthToken = claudeOAuthToken
  if (parsedCodex) {
    credentials.codex = {
      accessToken: parsedCodex.accessToken,
      accountId: parsedCodex.accountId,
    }
  }
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
          plan: 'Max 5x (mock)',
          windows: [
            {
              id: 'five_hour',
              label: '5-hour',
              usedPercent: 42,
              resetsAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
            },
            {
              id: 'seven_day',
              label: 'Weekly',
              usedPercent: 18,
              resetsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
            },
            {
              id: 'seven_day_fable',
              label: 'Weekly Fable',
              usedPercent: 33,
              resetsAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
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
      ],
    }
  }
}
