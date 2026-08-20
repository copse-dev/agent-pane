import type { LLMMessage } from './wire-types.ts'

/**
 * Deterministic secret redaction for the outbound REMOTE-LLM request path (#518).
 *
 * Copse can call third-party/cloud models (Anthropic, OpenAI, OpenRouter, other
 * OpenAI-compatible cloud providers). Tool results and conversation text can
 * easily contain credentials a user never meant to share with a third party —
 * a `cat .env`, a leaked CI log, an `Authorization:` header in a captured
 * request. This module scrubs known high-signal secret shapes BEFORE they leave
 * the device for a remote provider, replacing each match with a labelled
 * placeholder so the model still sees the surrounding structure.
 *
 * Design constraints:
 *  - Pure: `redactSecrets(text) -> text`, no I/O, no globals. Trivially testable.
 *  - Deterministic regex matching only — never a model, never a network call.
 *  - Focused, well-anchored patterns to avoid mangling ordinary prose. We would
 *    rather miss an exotic credential than corrupt normal text/code, so each
 *    pattern keys off a distinctive prefix/structure with enough entropy that a
 *    false positive is implausible.
 *  - Local / on-device models are intentionally NOT redacted (the secret never
 *    leaves the machine), so redaction is wired in at the remote provider only.
 */

interface SecretPattern {
  /** Placeholder label, e.g. GITHUB_TOKEN -> `[REDACTED_GITHUB_TOKEN]`. */
  readonly label: string
  /** Global regex matching the secret shape. */
  readonly regex: RegExp
  /**
   * Optional rewrite: when the match contains a non-secret prefix that must be
   * preserved (e.g. the `Authorization: Bearer ` part), return the replacement
   * for the whole match. Defaults to the bare placeholder.
   */
  readonly replace?: (match: string, ...groups: string[]) => string
}

const placeholder = (label: string): string => `[REDACTED_${label}]`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactLiteralSecrets(text: string, literalSecrets: readonly string[]): string {
  const literals = [...new Set(literalSecrets.filter((s) => s.trim().length >= 8))].sort(
    (a, b) => b.length - a.length,
  )
  let out = text
  for (const secret of literals) {
    out = out.replaceAll(new RegExp(escapeRegExp(secret), 'g'), placeholder('SECRET'))
  }
  return out
}

// Order matters only for readability; the patterns are mutually distinctive so
// they do not overlap on the same span in practice.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // GitHub fine-grained personal access tokens: `github_pat_` + 22 base62 + `_` +
  // 59 base62. Check this BEFORE the classic-token rule so the literal prefix is
  // not partially consumed.
  {
    label: 'GITHUB_TOKEN',
    regex: /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b/g,
  },
  // Classic GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server), ghr_ (refresh). 36 base62 chars in current format,
  // but allow 30-255 to stay robust to length changes.
  {
    label: 'GITHUB_TOKEN',
    regex: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/g,
  },
  // Anthropic API keys: `sk-ant-` + body. Checked BEFORE the OpenAI rule so the
  // shared `sk-` prefix is attributed to the correct label.
  {
    label: 'ANTHROPIC_API_KEY',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  // OpenAI API keys: `sk-` optionally with a project segment (`sk-proj-`, etc.),
  // then a long base62 body. Require length to avoid matching short `sk-` prose.
  // The negative lookahead skips `sk-ant-` so it is not mislabelled as OpenAI.
  {
    label: 'OPENAI_API_KEY',
    regex: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  // AWS access key IDs: AKIA/ASIA/AGPA/AIDA/AROA/AIPA/ANPA/ANVA + 16 uppercase
  // base32. (Covers long-term and temporary credential id prefixes.)
  {
    label: 'AWS_ACCESS_KEY_ID',
    regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  // Google API keys: `AIza` + 35 url-safe base64 chars.
  {
    label: 'GOOGLE_API_KEY',
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
  },
  // Slack tokens: xoxb/xoxp/xoxa/xoxr/xoxs- + body.
  {
    label: 'SLACK_TOKEN',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  // PEM private-key blocks (RSA/EC/OPENSSH/DSA/PGP and the generic form). The
  // body can contain newlines, so match across lines up to the END marker.
  {
    label: 'PRIVATE_KEY',
    regex:
      /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  // Generic `Authorization: Bearer <token>` / `Authorization: Basic <token>`
  // headers. Preserve the header name + scheme, redact only the credential.
  // Require a token of reasonable length so ordinary "bearer of bad news" prose
  // does not match.
  {
    label: 'AUTHORIZATION_HEADER',
    regex: /(Authorization\s*:\s*(?:Bearer|Basic|token)\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_match, prefix: string): string => `${prefix}${placeholder('AUTHORIZATION_HEADER')}`,
  },
]

/**
 * Replace every recognised secret in `text` with a labelled placeholder.
 * Returns the input unchanged when it contains no secrets (and short-circuits on
 * empty input). Pure and idempotent.
 */
export function redactSecrets(text: string, literalSecrets: readonly string[] = []): string {
  if (!text) return text
  let out = text
  for (const { label, regex, replace } of SECRET_PATTERNS) {
    out = out.replace(regex, (match, ...args) => {
      if (replace) {
        // `args` ends with offset + full string; pass through only the captured
        // groups the replacer cares about.
        const groups = args.filter((a): a is string => typeof a === 'string')
        return replace(match, ...groups)
      }
      return placeholder(label)
    })
  }
  return redactLiteralSecrets(out, literalSecrets)
}

/**
 * Apply {@link redactSecrets} to every text-bearing field of an outbound message
 * list: user text, image alt text is left alone, assistant text, tool-call
 * argument strings, and tool results (the most common secret carrier). Returns a
 * new array; inputs are not mutated. System prompts are app-authored, so they
 * are passed through untouched.
 */
export function redactMessages(
  messages: LLMMessage[],
  literalSecrets: readonly string[] = [],
): LLMMessage[] {
  return messages.map((m): LLMMessage => {
    if (m.role === 'system') return m
    if (m.role === 'user') {
      if (typeof m.content === 'string')
        return { role: 'user', content: redactSecrets(m.content, literalSecrets) }
      return {
        role: 'user',
        content: m.content.map((part) =>
          part.type === 'text'
            ? { type: 'text', text: redactSecrets(part.text, literalSecrets) }
            : part,
        ),
      }
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string')
        return { role: 'assistant', content: redactSecrets(m.content, literalSecrets) }
      return {
        role: 'assistant',
        content: m.content.map((tc) => ({
          ...tc,
          args: redactToolArgs(tc.args, literalSecrets),
        })),
      }
    }
    // role === 'tool'
    return {
      role: 'tool',
      toolResults: m.toolResults.map((tr) => ({
        ...tr,
        result: redactSecrets(tr.result, literalSecrets),
      })),
    }
  })
}

/**
 * Redact secrets inside structured tool-call arguments. We can only scrub string
 * leaves, so walk the value and rewrite strings; non-string leaves pass through.
 * Serialising to JSON would also catch secrets, but rebuilding the structure
 * keeps the shape the provider expects.
 */
function redactToolArgs(args: unknown, literalSecrets: readonly string[]): unknown {
  if (typeof args === 'string') return redactSecrets(args, literalSecrets)
  if (Array.isArray(args)) return args.map((value) => redactToolArgs(value, literalSecrets))
  if (args && typeof args === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) out[k] = redactToolArgs(v, literalSecrets)
    return out
  }
  return args
}
