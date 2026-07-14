/**
 * Durable control-plane **decision log** (issue #656).
 *
 * Separate from the conversation spine (#644, `spine-schema.ts`), this is an
 * append-only, machine-readable JSONL stream of every permission/decision the
 * app makes *around* a tool call: user approvals/denials (and whether they were
 * made sticky via "remember"), sandbox-vs-external scope classifications, and
 * hook allow/block verdicts. The spine answers "what did the agent do?"; this
 * answers "what did I approve, when, at what scope, and did I make it sticky?".
 *
 * This module is pure — no `node:fs`/`node:crypto`/Electron — so the schema and
 * the secret-redaction policy are unit-testable without shims. `id`/`at` are
 * injected by the writer (`decision-log-store.ts`) to keep it Node-free.
 *
 * ## Machine-readability / provability
 *
 * Each line is a self-describing JSON object carrying its own schema version
 * (`v`) and a fixed `type` discriminator, and the stream declares a media type
 * ({@link DECISION_LOG_MEDIA_TYPE}) plus a conformance target
 * ({@link DECISION_LOG_CONFORMANCE}) evaluated against
 * draft-vaughan-machine-readability. External tooling can therefore validate and
 * evaluate the log on its own, rather than merely re-reading it.
 */

/** Bump when the decision line shape changes in a backwards-incompatible way. */
export const DECISION_LOG_SCHEMA_VERSION = 1

/** Media type for the JSONL decision stream (one {@link DecisionEvent} per line). */
export const DECISION_LOG_MEDIA_TYPE = 'application/vnd.copse.decision-log+jsonl'

/**
 * Conformance target for the machine-readability evaluation asked for by #656.
 * A stable identifier external tooling can key its validators to.
 * @see https://datatracker.ietf.org/doc/draft-vaughan-machine-readability/
 */
export const DECISION_LOG_CONFORMANCE = 'draft-vaughan-machine-readability' as const

/** Who made the decision. */
export type DecisionActor = 'user' | 'classifier' | 'hook'

/**
 * The outcome. `approved`/`denied` are user verdicts; `allowed`/`blocked`/`ask`
 * are non-interactive policy/hook verdicts; `timeout` is a prompt that expired
 * unanswered (treated as a denial by the caller, recorded distinctly here).
 */
export type DecisionVerdict = 'approved' | 'denied' | 'allowed' | 'blocked' | 'ask' | 'timeout'

/** One line of `decisions.jsonl`: a single control-plane decision. */
export interface DecisionEvent {
  v: number
  type: 'decision'
  /** Opaque unique id (uuid), assigned by the writer. */
  id: string
  /** Epoch milliseconds, assigned by the writer. */
  at: number
  /**
   * Decision domain, e.g. `shell` | `mcp` | `web` | `pii` | `browser` |
   * `github-write` | `custom-tool` | `port-binding` | `model-compare` | `acp` |
   * `install` | `classification` | `hook`. A free string so new gates need no
   * schema bump; consumers should treat unknown kinds gracefully.
   */
  kind: string
  actor: DecisionActor
  verdict: DecisionVerdict
  /** Redacted subject the decision was about: a command, tool name, or origin. */
  subject: string
  /** Scope the decision applied at / granted, e.g. `sandbox` | `external`. */
  scope?: string
  /** Whether the grant was made sticky (the "remember" checkbox). */
  remembered?: boolean
  /** Classifier confidence in [0, 1], when the actor is a classifier. */
  confidence?: number
  /** Redacted policy/classifier/hook reasons. */
  reasons?: string[]
  /** Originating thread id (links back to the spine), when known. */
  threadId?: string
  /** Redacted extra context: hook config path, classifier model id, etc. */
  source?: string
}

/** Longest subject/reason we persist; keeps a runaway command line bounded. */
const MAX_FIELD_LEN = 4000

/**
 * Durable shell events intentionally omit the command text. Best-effort
 * redaction cannot identify arbitrary positional secrets (for example,
 * `sshpass -p hunter2`), so persisting the raw command would turn the audit log
 * into a credential sink.
 */
export const SHELL_DECISION_SUBJECT = 'shell command (arguments omitted)'

/**
 * Redact secrets that commonly appear verbatim in recorded commands before they
 * are written to the durable log (#656 asks for a redaction policy). Conservative
 * by design — it targets well-known secret shapes and `KEY=`/`--flag value`
 * assignments rather than blanket-scrubbing long tokens, so the recorded subject
 * stays useful for auditing. Not a guarantee that no secret ever slips through;
 * it removes the obvious ones.
 */
export function redactSecrets(input: string): string {
  let out = input
  // url userinfo:  scheme://user:pass@host  ->  scheme://<redacted>@host
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
  // Authorization / Bearer header values.
  out = out.replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
  out = out.replace(/\b(Authorization\s*[:=]\s*)\S+/gi, '$1<redacted>')
  // Known provider token shapes.
  out = out.replace(
    /\b(gh[posru]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/g,
    '<redacted>',
  )
  // Secret-ish env assignments:  FOO_TOKEN=value  /  api_key: value
  out = out.replace(
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1$2<redacted>',
  )
  // Secret-ish command flags:  --password value  /  --token=value
  out = out.replace(
    /(--?(?:password|passwd|token|secret|api[_-]?key|auth)(?:[=\s]))(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1<redacted>',
  )
  return out
}

/** Clamp a field to {@link MAX_FIELD_LEN}, appending an ellipsis marker when cut. */
function clampField(value: string): string {
  return value.length > MAX_FIELD_LEN ? `${value.slice(0, MAX_FIELD_LEN)}…` : value
}

/** Fields a caller supplies; the writer adds `id`/`at`/`v`/`type`. */
export type DecisionInput = Omit<DecisionEvent, 'v' | 'type' | 'id' | 'at'>

/**
 * Build a finalized {@link DecisionEvent} from caller input, applying redaction
 * to every free-text field and clamping length. `id`/`at` are injected so this
 * stays pure and deterministic under test.
 */
export function makeDecisionEvent(input: DecisionInput, id: string, at: number): DecisionEvent {
  const event: DecisionEvent = {
    v: DECISION_LOG_SCHEMA_VERSION,
    type: 'decision',
    id,
    at,
    kind: input.kind,
    actor: input.actor,
    verdict: input.verdict,
    subject: clampField(redactSecrets(input.subject)),
  }
  if (input.scope !== undefined) event.scope = input.scope
  if (input.remembered !== undefined) event.remembered = input.remembered
  if (input.confidence !== undefined) event.confidence = input.confidence
  if (input.reasons && input.reasons.length > 0) {
    event.reasons = input.reasons.map((r) => clampField(redactSecrets(r)))
  }
  if (input.threadId !== undefined) event.threadId = input.threadId
  if (input.source !== undefined) event.source = clampField(redactSecrets(input.source))
  return event
}

export function serializeDecisionLine(event: DecisionEvent): string {
  return JSON.stringify(event)
}

/** Parse one line. Returns null on malformed JSON or a non-decision line. */
export function parseDecisionLine(raw: string): DecisionEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { type?: unknown }).type !== 'decision' ||
    typeof (parsed as { id?: unknown }).id !== 'string' ||
    typeof (parsed as { kind?: unknown }).kind !== 'string'
  ) {
    return null
  }
  return parsed as DecisionEvent
}

/** Parse a full `decisions.jsonl` body, skipping blank or malformed lines. */
export function parseDecisionLog(raw: string): DecisionEvent[] {
  const out: DecisionEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseDecisionLine(line)
    if (parsed) out.push(parsed)
  }
  return out
}

/** Serialize a full `decisions.jsonl` body (trailing newline when non-empty). */
export function serializeDecisionLog(events: DecisionEvent[]): string {
  return events.map(serializeDecisionLine).join('\n') + (events.length > 0 ? '\n' : '')
}

/** Self-describing manifest emitted at the head of an export (see the store). */
export interface DecisionLogManifest {
  type: 'decision-log-manifest'
  mediaType: string
  schemaVersion: number
  conformance: string
  /** Epoch ms the export was produced (injected, for purity/testability). */
  exportedAt: number
  /** Number of decision events that follow the manifest line. */
  count: number
}

export function decisionLogManifest(count: number, exportedAt: number): DecisionLogManifest {
  return {
    type: 'decision-log-manifest',
    mediaType: DECISION_LOG_MEDIA_TYPE,
    schemaVersion: DECISION_LOG_SCHEMA_VERSION,
    conformance: DECISION_LOG_CONFORMANCE,
    exportedAt,
    count,
  }
}
