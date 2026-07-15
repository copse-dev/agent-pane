import { isRecord } from './internal-utils.ts'

/**
 * Pull a Claude.ai OAuth access token from the on-disk credentials JSON
 * Claude Code writes (`~/.claude/.credentials.json`). Returns `null` when the
 * shape is missing or is an API-key-only install.
 */
export function parseClaudeCredentialsJson(raw: unknown): string | null {
  if (!isRecord(raw)) return null
  const oauth = raw['claudeAiOauth']
  if (!isRecord(oauth)) return null
  const token = oauth['accessToken']
  return typeof token === 'string' && token.trim() ? token.trim() : null
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
