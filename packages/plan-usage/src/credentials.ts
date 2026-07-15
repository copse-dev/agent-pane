import { isRecord } from './internal-utils.ts'

/**
 * Pull a Claude.ai OAuth access token from the on-disk credentials JSON
 * Claude Code writes (`~/.claude/.credentials.json` or macOS Keychain payload).
 * Returns `null` when the shape is missing or is an API-key-only install.
 */
export function parseClaudeCredentialsJson(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      return parseClaudeCredentialsJson(JSON.parse(trimmed) as unknown)
    } catch {
      // Bare token string (rare).
      return trimmed.startsWith('sk-ant-oat') ? trimmed : null
    }
  }
  if (!isRecord(raw)) return null
  const oauth = raw['claudeAiOauth']
  if (!isRecord(oauth)) return null
  const token = oauth['accessToken']
  return typeof token === 'string' && token.trim() ? token.trim() : null
}

export type ClaudeTokenSource = 'keychain' | 'credentials.json' | 'env'

export interface ClaudeTokenCandidate {
  source: ClaudeTokenSource
  token: string
}

/**
 * Deduped Claude OAuth candidates in preference order: Keychain (macOS
 * `claude /login`), then credentials file, then `CLAUDE_CODE_OAUTH_TOKEN`.
 * Callers should try each until `/api/oauth/usage` succeeds — env setup-tokens
 * lack `user:profile` and 403.
 */
export function orderClaudeTokenCandidates(input: {
  keychainJson?: string | null
  credentialsJson?: unknown
  envToken?: string | null
}): ClaudeTokenCandidate[] {
  const out: ClaudeTokenCandidate[] = []
  const seen = new Set<string>()

  const push = (source: ClaudeTokenSource, token: string | null | undefined): void => {
    const value = token?.trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push({ source, token: value })
  }

  push('keychain', parseClaudeCredentialsJson(input.keychainJson ?? null))
  push('credentials.json', parseClaudeCredentialsJson(input.credentialsJson ?? null))
  push('env', input.envToken)

  return out
}

/**
 * Pull a Hugging Face access token from a token file (`~/.cache/huggingface/token`)
 * or a bare `hf_…` / env string. Returns `null` when empty / missing.
 */
export function parseHuggingFaceToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Token files are plain text; reject obvious JSON/HTML mistakes.
  if (trimmed.startsWith('{') || trimmed.startsWith('<')) return null
  return trimmed
}

export interface ParsedCodexAuth {
  accessToken: string
  accountId: string | null
}

/**
 * Pull ChatGPT / Codex tokens from `~/.codex/auth.json` (or equivalent).
 */
export function parseCodexAuthJson(raw: unknown): ParsedCodexAuth | null {
  if (!isRecord(raw)) return null
  const tokens = raw['tokens']
  if (!isRecord(tokens)) return null
  const accessToken = tokens['access_token'] ?? tokens['accessToken']
  if (typeof accessToken !== 'string' || !accessToken.trim()) return null
  const accountIdRaw = tokens['account_id'] ?? tokens['accountId']
  const accountId =
    typeof accountIdRaw === 'string' && accountIdRaw.trim() ? accountIdRaw.trim() : null
  return { accessToken: accessToken.trim(), accountId }
}
