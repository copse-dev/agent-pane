import type { LLMMessage, ToolResult } from '@shared/types'

/**
 * Deterministic, on-device redaction of secret tokens before any prompt or
 * context is handed to a *remote* model (issue #518). The goal is to make sure
 * GitHub tokens, provider API keys, and similar credentials — which often leak
 * into file contents, command output, or tool results that get folded into the
 * conversation — never travel to a third party that could then use them.
 *
 * This is intentionally pattern-based and conservative: we only redact strings
 * that match well-known, high-entropy credential shapes (so ordinary prose is
 * left intact), plus any explicit literal secrets the caller already knows about
 * (e.g. the user's configured provider keys). Local models are never wrapped, so
 * on-device flows keep working with real tokens.
 */

export const REDACTED_PLACEHOLDER = '[redacted-secret]'

interface SecretPattern {
  readonly label: string
  readonly regex: RegExp
}

/**
 * Known credential token shapes. Each is anchored on a distinctive prefix and a
 * length floor so we don't redact short, ambiguous fragments. `g` flag is
 * required — `replaceAll` with a RegExp throws otherwise, and we need every
 * occurrence.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // GitHub tokens: PAT (classic ghp_), OAuth (gho_), user/server (ghu_/ghs_),
  // refresh (ghr_), and fine-grained PATs (github_pat_…).
  { label: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { label: 'github-fine-grained-pat', regex: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  // OpenAI keys (sk-…, sk-proj-…) and Anthropic keys (sk-ant-…).
  { label: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'openai-key', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  // OpenRouter keys.
  { label: 'openrouter-key', regex: /\bsk-or-v1-[A-Za-z0-9]{32,}\b/g },
  // AWS access key ids.
  { label: 'aws-access-key-id', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // Google API keys.
  { label: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Slack tokens (bot/user/app/legacy).
  { label: 'slack-token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  // Stripe secret/live/restricted keys.
  { label: 'stripe-key', regex: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  // GitLab personal access tokens.
  { label: 'gitlab-pat', regex: /\bglpat-[0-9A-Za-z_-]{20,}\b/g },
  // Hugging Face user access tokens.
  { label: 'huggingface-token', regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
]

/** Escape a literal string for safe inclusion in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Redact secret tokens from a single string. Applies the known credential
 * patterns, then any explicit literal secrets the caller supplied (longest
 * first, so a key that is a prefix of another doesn't leave a tail behind).
 * Returns the input unchanged when there is nothing to redact.
 */
export function redactSecretsFromText(text: string, literalSecrets: readonly string[] = []): string {
  if (!text) return text
  let out = text
  for (const { regex } of SECRET_PATTERNS) {
    // Reset lastIndex defensively; these are module-level `g` regexes.
    regex.lastIndex = 0
    out = out.replace(regex, REDACTED_PLACEHOLDER)
  }
  // Only redact literals that are long enough to be real secrets, so an empty
  // or trivially short configured value can't blank out ordinary text.
  const literals = [...new Set(literalSecrets.filter((s) => s.trim().length >= 8))].sort(
    (a, b) => b.length - a.length,
  )
  for (const secret of literals) {
    out = out.replace(new RegExp(escapeRegExp(secret.trim()), 'g'), REDACTED_PLACEHOLDER)
  }
  return out
}

function redactToolResults(results: ToolResult[], literals: readonly string[]): ToolResult[] {
  let changed = false
  const next = results.map((r) => {
    const redacted = redactSecretsFromText(r.result, literals)
    if (redacted !== r.result) changed = true
    return redacted === r.result ? r : { ...r, result: redacted }
  })
  return changed ? next : results
}

/**
 * Return a copy of `messages` with secret tokens redacted from every textual
 * part the model would see: user/system text, image-array text blocks, assistant
 * text, and tool results. Tool-call argument objects and image data URLs are left
 * structurally intact (args are model-authored, not a secret-leak vector here).
 *
 * Messages are copied only when a redaction actually occurs, so the common
 * no-secret case returns the original array and objects unchanged.
 */
export function redactMessages(
  messages: readonly LLMMessage[],
  literalSecrets: readonly string[] = [],
): LLMMessage[] {
  return messages.map((m): LLMMessage => {
    if (m.role === 'system') {
      const content = redactSecretsFromText(m.content, literalSecrets)
      return content === m.content ? m : { ...m, content }
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        const content = redactSecretsFromText(m.content, literalSecrets)
        return content === m.content ? m : { ...m, content }
      }
      let changed = false
      const content = m.content.map((part) => {
        if (part.type === 'text') {
          const text = redactSecretsFromText(part.text, literalSecrets)
          if (text !== part.text) changed = true
          return text === part.text ? part : { ...part, text }
        }
        return part
      })
      return changed ? { ...m, content } : m
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        const content = redactSecretsFromText(m.content, literalSecrets)
        return content === m.content ? m : { ...m, content }
      }
      return m
    }
    // role === 'tool'
    const toolResults = redactToolResults(m.toolResults, literalSecrets)
    return toolResults === m.toolResults ? m : { ...m, toolResults }
  })
}
