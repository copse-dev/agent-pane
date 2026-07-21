import { isRecord } from './internal-utils.ts'

/**
 * Full Claude.ai OAuth credential as `claude /login` stores it. The access token
 * is short-lived; `refreshToken` mints a new one and `expiresAt` (epoch ms) says
 * when the current one dies. Both are `null` for env / bare-token installs that
 * only carry an access token.
 */
export interface ClaudeOAuthCredential {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
}

/**
 * Pull the full Claude.ai OAuth credential from the on-disk JSON Claude Code
 * writes (`~/.claude/.credentials.json` or macOS Keychain payload). Returns
 * `null` when the shape is missing or is an API-key-only install.
 */
export function parseClaudeOAuthCredential(raw: unknown): ClaudeOAuthCredential | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    try {
      return parseClaudeOAuthCredential(JSON.parse(trimmed) as unknown)
    } catch {
      // Bare token string (rare) — no refresh token travels with it.
      return trimmed.startsWith('sk-ant-oat')
        ? { accessToken: trimmed, refreshToken: null, expiresAt: null }
        : null
    }
  }
  if (!isRecord(raw)) return null
  const oauth = raw['claudeAiOauth']
  if (!isRecord(oauth)) return null
  const token = oauth['accessToken']
  if (typeof token !== 'string' || !token.trim()) return null
  const refresh = oauth['refreshToken']
  const expires = oauth['expiresAt']
  return {
    accessToken: token.trim(),
    refreshToken: typeof refresh === 'string' && refresh.trim() ? refresh.trim() : null,
    expiresAt: typeof expires === 'number' && Number.isFinite(expires) ? expires : null,
  }
}

/**
 * Pull a Claude.ai OAuth access token from the on-disk credentials JSON.
 * Thin wrapper over {@link parseClaudeOAuthCredential} for callers that only
 * need the bearer token.
 */
export function parseClaudeCredentialsJson(raw: unknown): string | null {
  return parseClaudeOAuthCredential(raw)?.accessToken ?? null
}

export type ClaudeTokenSource = 'keychain' | 'credentials.json' | 'env'

export interface ClaudeTokenCandidate {
  source: ClaudeTokenSource
  token: string
}

/** A Claude OAuth credential tagged with the store it came from (for write-back). */
export interface ClaudeCredentialCandidate extends ClaudeOAuthCredential {
  source: ClaudeTokenSource
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
 * Like {@link orderClaudeTokenCandidates} but keeps the full credential
 * (refresh token + expiry) and its source, so the caller can refresh an expired
 * access token and persist the rotation back to the right store. Deduped by
 * access token in preference order: Keychain, credentials file, then env.
 */
export function orderClaudeOAuthCredentials(input: {
  keychainJson?: string | null
  credentialsJson?: unknown
  envToken?: string | null
}): ClaudeCredentialCandidate[] {
  const out: ClaudeCredentialCandidate[] = []
  const seen = new Set<string>()

  const push = (source: ClaudeTokenSource, cred: ClaudeOAuthCredential | null): void => {
    if (!cred || seen.has(cred.accessToken)) return
    seen.add(cred.accessToken)
    out.push({ source, ...cred })
  }

  push('keychain', parseClaudeOAuthCredential(input.keychainJson ?? null))
  push('credentials.json', parseClaudeOAuthCredential(input.credentialsJson ?? null))
  const envToken = input.envToken?.trim()
  push('env', envToken ? { accessToken: envToken, refreshToken: null, expiresAt: null } : null)

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

/**
 * Normalize a Cursor session token from env / cookie paste. Accepts the
 * WorkosCursorSessionToken cookie value, `sub::jwt`, or a raw JWT.
 */
export function parseCursorSessionToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
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
