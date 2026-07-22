// The canonical headless automation contract (issue #1079 —
// docs/plans/headless-automation-contract.md).
//
// Copse already has three consumers of a non-UI turn lifecycle — the benchmark
// harness (scripts/bench-agent-lib.mts), the ACP agent server
// (src/main/services/acp/*), and a future CLI — but each speaks its own dialect:
// requests are implicit, tool-call/event shapes are duplicated three ways
// (`AgentStreamChunk` ↔ `SpineToolCall` ↔ ACP `SessionUpdate`), stop reasons are
// bare strings, exit codes are ad-hoc `process.exit` calls, and permission
// decisions use three different vocabularies. This module is the SINGLE SOURCE OF
// TRUTH that reconciles them: one versioned request/event/permission contract,
// authored as zod schemas so the TypeScript types (`z.infer`) and the published
// JSON Schema (`z.toJSONSchema`, see `headlessContractJsonSchema`) are generated
// from the same declaration.
//
// It lives in `@copse/agent` (Electron-free, depends only on `@copse/llm` + zod)
// because every adapter — bench harness, ACP server, CLI — must be able to import
// it without pulling in `src/main`. Adapters are conformance CONSUMERS of this
// contract, not co-authors of it: an adapter maps its transport onto these types
// and its behavior is checked against them.
//
// Scope of this module (Phase 0): the wire types, the identifier vocabulary, the
// permission model, the exit-code/stop-reason enumerations, and the projection
// from the loop's native `AgentStreamChunk` stream onto the canonical event
// envelope. It deliberately does NOT rewire the existing bench/ACP/spine code —
// those become conformance consumers in later phases (see the plan doc).
import { z } from 'zod'
import {
  isContextOverflowStopReason,
  isRefusalStopReason,
  isTruncationStopReason,
} from '@copse/llm/provider-stop-reason.ts'
import type { AgentStreamChunk } from './wire-types.ts'

// ── Protocol version ─────────────────────────────────────────────────────────

/**
 * The headless-contract version this build speaks. Bumped only on a
 * backward-incompatible change to the request or event envelope; additive fields
 * (which every reader must tolerate — see the `v`/unknown-field policy below) do
 * not bump it. Clients and servers reconcile via {@link negotiateProtocolVersion}.
 */
export const HEADLESS_PROTOCOL_VERSION = 1 as const

/**
 * Pick the highest protocol version both sides speak. Returns `null` when there
 * is no overlap (the client requires a newer minimum than the server offers, or
 * vice versa), which a transport must treat as a failed handshake rather than
 * silently downgrading past a peer's floor.
 */
export function negotiateProtocolVersion(
  clientVersion: number,
  serverVersion: number = HEADLESS_PROTOCOL_VERSION,
): number | null {
  if (!Number.isInteger(clientVersion) || clientVersion < 1) return null
  if (!Number.isInteger(serverVersion) || serverVersion < 1) return null
  return Math.min(clientVersion, serverVersion)
}

// ── Canonical identifiers ────────────────────────────────────────────────────

// The lifecycle is Thread → Turn → Item (the naming the codex-oss architecture
// comparison settled on). Every event carries the ids needed to place it in that
// tree. Ids are opaque strings minted by the runtime; the contract only fixes
// *which* id appears *where*, never how it is generated. Kept as documented
// string aliases (not zod brands) so they survive `z.toJSONSchema` as plain
// `string`.
export type ThreadId = string
export type TurnId = string
export type ItemId = string
export type ToolCallId = string
export type ApprovalId = string

// ── Permission model ─────────────────────────────────────────────────────────

/**
 * The one canonical permission decision vocabulary. Copse today has three —
 * hook `'allow'|'deny'|'ask'`, ACP `'allow'|'reject'|'cancelled'`, and ACP
 * session modes — so the contract fixes a single set and adapters map onto it.
 * `'ask'` means "defer to an interactive approver"; in a non-interactive run it
 * is resolved by {@link resolveNonInteractiveDecision}, never silently widened.
 */
export const headlessPermissionDecisionSchema = z.enum(['allow', 'deny', 'ask'])
export type HeadlessPermissionDecision = z.infer<typeof headlessPermissionDecisionSchema>

/**
 * A declarative permission profile: a default decision plus per-capability
 * overrides for the four effect classes an automated run can take. A headless
 * caller names a profile in its request; the runtime resolves each tool action
 * against it. Capabilities describe *effects*, not command prefixes — the
 * per-segment shell analysis that already exists stays authoritative for *how* a
 * shell command is classified.
 */
export const headlessPermissionProfileSchema = z.object({
  id: z.string().min(1).describe('Stable profile identifier a request can reference by name.'),
  default: headlessPermissionDecisionSchema.describe(
    'Decision applied to any capability without an explicit override.',
  ),
  fileWrite: headlessPermissionDecisionSchema
    .optional()
    .describe('Writing files in the workspace.'),
  shell: headlessPermissionDecisionSchema.optional().describe('Running shell commands.'),
  network: headlessPermissionDecisionSchema.optional().describe('Outbound network access.'),
  mcpMutation: headlessPermissionDecisionSchema
    .optional()
    .describe('Mutating (non-read) MCP tool calls.'),
})
export type HeadlessPermissionProfile = z.infer<typeof headlessPermissionProfileSchema>

/**
 * The default profile for non-interactive / CI runs: deny by default, and every
 * unset capability inherits that deny. This encodes the contract's hard rule —
 * "headless mode cannot silently broaden permissions when interactive approval is
 * unavailable." A caller that wants a broader profile must pass one explicitly.
 */
export const CI_DENY_BY_DEFAULT_PROFILE: HeadlessPermissionProfile = {
  id: 'ci-deny-by-default',
  default: 'deny',
}

/**
 * Resolve a profile decision for a capability when no interactive approver is
 * attached. `'ask'` fails CLOSED to `'deny'` — an unattended run must never block
 * forever waiting for an approval it can never receive, and must never proceed as
 * if approval were granted. With an interactive channel present, `'ask'` is left
 * intact for the approver to handle.
 */
export function resolveNonInteractiveDecision(
  decision: HeadlessPermissionDecision,
  opts: { interactive: boolean },
): HeadlessPermissionDecision {
  if (decision === 'ask' && !opts.interactive) return 'deny'
  return decision
}

/**
 * The effective decision for one capability under a profile: its override if set,
 * else the profile default.
 */
export function capabilityDecision(
  profile: HeadlessPermissionProfile,
  capability: 'fileWrite' | 'shell' | 'network' | 'mcpMutation',
): HeadlessPermissionDecision {
  return profile[capability] ?? profile.default
}

// ── Run requests: new / resume / fork ────────────────────────────────────────

/** How the runtime should render its event stream to stdout. */
export const headlessOutputModeSchema = z.enum(['jsonl', 'text'])
export type HeadlessOutputMode = z.infer<typeof headlessOutputModeSchema>

// Fields shared by every request kind. `permissionProfile` names a profile by id
// (the runtime resolves it); absent means the deny-by-default CI profile — the
// safe default for an unattended caller.
const runRequestBase = {
  cwd: z.string().min(1).describe('Absolute path of the workspace root the turn runs against.'),
  input: z.string().min(1).describe('The user prompt for this turn.'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe('Model id override; absent uses the runtime default.'),
  outputMode: headlessOutputModeSchema.default('jsonl'),
  permissionProfile: z
    .string()
    .min(1)
    .default(CI_DENY_BY_DEFAULT_PROFILE.id)
    .describe('Id of the permission profile to run under.'),
}

/** Start a brand-new thread. */
export const headlessNewRequestSchema = z.object({
  kind: z.literal('new'),
  ...runRequestBase,
})

/** Continue an existing thread with a new turn. */
export const headlessResumeRequestSchema = z.object({
  kind: z.literal('resume'),
  threadId: z.string().min(1).describe('Thread to resume.'),
  ...runRequestBase,
})

/**
 * Branch a new thread from an existing one, optionally rewound to a prior turn.
 * The source thread is never mutated; the fork is an independent thread seeded
 * from the source's history up to `fromTurnId` (inclusive) — or the whole thread
 * when omitted.
 */
export const headlessForkRequestSchema = z.object({
  kind: z.literal('fork'),
  sourceThreadId: z.string().min(1).describe('Thread to fork from.'),
  fromTurnId: z
    .string()
    .min(1)
    .optional()
    .describe('Rewind point: seed the fork with history through this turn. Absent = full history.'),
  ...runRequestBase,
})

export const headlessRunRequestSchema = z.discriminatedUnion('kind', [
  headlessNewRequestSchema,
  headlessResumeRequestSchema,
  headlessForkRequestSchema,
])
export type HeadlessRunRequest = z.infer<typeof headlessRunRequestSchema>
export type HeadlessNewRequest = z.infer<typeof headlessNewRequestSchema>
export type HeadlessResumeRequest = z.infer<typeof headlessResumeRequestSchema>
export type HeadlessForkRequest = z.infer<typeof headlessForkRequestSchema>

/**
 * Parse and default-fill an untrusted request payload. Throws `z.ZodError` on a
 * malformed request — a transport maps that to the {@link HEADLESS_EXIT.USAGE}
 * exit code rather than starting a turn.
 */
export function parseHeadlessRunRequest(raw: unknown): HeadlessRunRequest {
  return headlessRunRequestSchema.parse(raw)
}

// ── Terminal outcomes and stop reasons ───────────────────────────────────────

/**
 * How a turn ended. `awaiting_approval` / `awaiting_input` are *non-terminal*
 * pauses that hand control back to the caller (the interrupted turn is
 * resumable); the rest are terminal.
 */
export const headlessOutcomeSchema = z.enum([
  'completed',
  'failed',
  'cancelled',
  'awaiting_approval',
  'awaiting_input',
])
export type HeadlessOutcome = z.infer<typeof headlessOutcomeSchema>

/**
 * The canonical stop-reason vocabulary. Provider `done.stopReason` is a bare,
 * provider-specific string (Anthropic `stop_reason` / OpenAI `finish_reason`);
 * {@link normalizeStopReason} folds it into this enum so adapters compare against
 * one set.
 */
export const headlessStopReasonSchema = z.enum([
  'end_turn', // model finished normally
  'max_steps', // loop hit its step / tool-call budget
  'max_tokens', // provider truncated on output length
  'context_overflow', // conversation exceeded the model context window
  'refusal', // model declined / content filter
  'timeout', // wall-clock deadline fired
  'cancelled', // caller aborted (signal)
  'tool_denied', // a required tool action was denied by policy
  'error', // an error ended the turn
])
export type HeadlessStopReason = z.infer<typeof headlessStopReasonSchema>

/**
 * Fold a provider's bare `done.stopReason` string into the canonical enum. A
 * normal finish (or an absent reason) is `end_turn`; the truncation / refusal /
 * context-overflow classifiers owned by `@copse/llm` are reused so this module
 * does not re-encode provider-string knowledge.
 */
export function normalizeStopReason(raw: string | undefined): HeadlessStopReason {
  if (isTruncationStopReason(raw)) return 'max_tokens'
  if (isRefusalStopReason(raw)) return 'refusal'
  if (isContextOverflowStopReason(raw)) return 'context_overflow'
  switch (raw) {
    case undefined:
    case '':
    case 'stop':
    case 'end_turn':
    case 'tool_use':
    case 'tool_calls':
      return 'end_turn'
    case 'max_steps':
      return 'max_steps'
    case 'timeout':
      return 'timeout'
    case 'cancelled':
    case 'aborted':
      return 'cancelled'
    default:
      return 'end_turn'
  }
}

// ── Exit codes ───────────────────────────────────────────────────────────────

/**
 * Documented process exit statuses for a one-shot headless run. Values follow
 * shell convention where one exists: 130 = terminated by SIGINT (128+2), 124 =
 * timed out (coreutils `timeout`, already used by the terminal-bench adapter).
 */
export const HEADLESS_EXIT = {
  /** Turn completed successfully. */
  SUCCESS: 0,
  /** Turn ran but failed (error stop, or a task the caller graded as unsolved). */
  FAILURE: 1,
  /** The request itself was malformed / unusable — nothing ran. */
  USAGE: 2,
  /** A required approval could not be obtained in a non-interactive run. */
  APPROVAL_REQUIRED: 3,
  /** The wall-clock deadline fired. */
  TIMEOUT: 124,
  /** The caller cancelled the run (SIGINT/SIGTERM). */
  CANCELLED: 130,
} as const
export type HeadlessExitCode = (typeof HEADLESS_EXIT)[keyof typeof HEADLESS_EXIT]

/**
 * The exit code a one-shot run should report for a terminal outcome. Non-terminal
 * pauses map to their own codes so a CI caller can distinguish "needs approval"
 * from a hard failure.
 */
export function exitCodeForOutcome(
  outcome: HeadlessOutcome,
  stopReason?: HeadlessStopReason,
): HeadlessExitCode {
  switch (outcome) {
    case 'completed':
      return HEADLESS_EXIT.SUCCESS
    case 'cancelled':
      return HEADLESS_EXIT.CANCELLED
    case 'awaiting_approval':
      return HEADLESS_EXIT.APPROVAL_REQUIRED
    case 'awaiting_input':
      // The caller must resume with more input; treated as a usage-level pause.
      return HEADLESS_EXIT.USAGE
    case 'failed':
      return stopReason === 'timeout' ? HEADLESS_EXIT.TIMEOUT : HEADLESS_EXIT.FAILURE
    default:
      return HEADLESS_EXIT.FAILURE
  }
}

// ── Canonical event envelope ─────────────────────────────────────────────────

// Every event is a versioned line: `v` is the envelope version. In `jsonl`
// output mode one JSON object is written per line to stdout; `text` mode renders
// the same events human-readably. stderr is reserved for diagnostics and never
// carries contract events.
//
// Forward-compatibility is a *reader* behavior, not a schema-openness claim: a
// lenient reader (like the thread-store spine's `parseSpine`) skips lines whose
// `type`/`v` it does not recognise and ignores unknown fields — and the zod
// parser here strips unknown keys the same way. The published JSON Schema, by
// contrast, pins the exact closed v1 shape (`additionalProperties: false`,
// `v: const 1`); strict validation against it is deliberately NOT
// forward-tolerant, so a consumer that must accept future versions parses
// leniently rather than strict-validating. See {@link headlessContractJsonSchema}.
const eventBase = { v: z.literal(1) }

export const headlessTurnStartEventSchema = z.object({
  ...eventBase,
  type: z.literal('turn_start'),
  threadId: z.string(),
  turnId: z.string(),
  protocolVersion: z.number().int().positive(),
})

export const headlessMessageEventSchema = z.object({
  ...eventBase,
  type: z.literal('message'),
  turnId: z.string(),
  itemId: z.string(),
  role: z.enum(['assistant', 'user']),
  text: z.string(),
})

export const headlessReasoningEventSchema = z.object({
  ...eventBase,
  type: z.literal('reasoning'),
  turnId: z.string(),
  itemId: z.string(),
  text: z.string(),
})

export const headlessToolCallEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool_call'),
  turnId: z.string(),
  itemId: z.string(),
  toolCallId: z.string(),
  name: z.string(),
  kind: z.string().optional(),
  args: z.unknown(),
})

export const headlessToolResultEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool_result'),
  turnId: z.string(),
  toolCallId: z.string(),
  status: z.enum(['done', 'error']),
  result: z.string(),
  editStats: z.object({ additions: z.number(), deletions: z.number() }).optional(),
})

export const headlessApprovalRequestEventSchema = z.object({
  ...eventBase,
  type: z.literal('approval_request'),
  turnId: z.string(),
  approvalId: z.string(),
  toolCallId: z.string().optional(),
  title: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
})

export const headlessTurnEndEventSchema = z.object({
  ...eventBase,
  type: z.literal('turn_end'),
  turnId: z.string(),
  outcome: headlessOutcomeSchema,
  stopReason: headlessStopReasonSchema.optional(),
})

export const headlessEventSchema = z.discriminatedUnion('type', [
  headlessTurnStartEventSchema,
  headlessMessageEventSchema,
  headlessReasoningEventSchema,
  headlessToolCallEventSchema,
  headlessToolResultEventSchema,
  headlessApprovalRequestEventSchema,
  headlessTurnEndEventSchema,
])
export type HeadlessEvent = z.infer<typeof headlessEventSchema>

/** Serialize one event as a JSONL line (no trailing newline). */
export function serializeHeadlessEvent(event: HeadlessEvent): string {
  return JSON.stringify(event)
}

// ── Projection from the loop's native stream ─────────────────────────────────

/**
 * Map one `AgentStreamChunk` — the loop's native output — onto zero or more
 * canonical events. This is the shared core every headless adapter needs: the
 * bench harness, the ACP server, and the CLI all drive `runAgentLoop` and must
 * turn its chunks into the same wire events. Chunks with no contract
 * representation (usage accounting, context-pressure signals, panel updates) map
 * to `[]`.
 *
 * `mintItemId` supplies a fresh item id for chunks that open a new item (a text
 * delta, a reasoning delta); tool calls reuse the provider's tool-call id as the
 * item id so a call and its result stay linked. Kept as an injected callback so
 * this module needs no id generator of its own (and stays deterministic in
 * tests).
 */
export function projectStreamChunk(
  chunk: AgentStreamChunk,
  ctx: { turnId: TurnId; mintItemId: () => ItemId },
): HeadlessEvent[] {
  switch (chunk.type) {
    case 'text':
      return [
        {
          v: 1,
          type: 'message',
          turnId: ctx.turnId,
          itemId: ctx.mintItemId(),
          role: 'assistant',
          text: chunk.text,
        },
      ]
    case 'reasoning':
      return [
        { v: 1, type: 'reasoning', turnId: ctx.turnId, itemId: ctx.mintItemId(), text: chunk.text },
      ]
    case 'tool_call':
      return [
        {
          v: 1,
          type: 'tool_call',
          turnId: ctx.turnId,
          itemId: chunk.toolCall.id,
          toolCallId: chunk.toolCall.id,
          name: chunk.toolCall.name,
          ...(chunk.toolCall.kind !== undefined ? { kind: chunk.toolCall.kind } : {}),
          args: chunk.toolCall.args,
        },
      ]
    case 'tool_result':
      return [
        {
          v: 1,
          type: 'tool_result',
          turnId: ctx.turnId,
          toolCallId: chunk.toolCallId,
          status: chunk.isError ? 'error' : 'done',
          result: chunk.result,
          ...(chunk.editStats !== undefined ? { editStats: chunk.editStats } : {}),
        },
      ]
    default:
      // usage / done / text_replace / context_pressure / subagent_* / panel_update
      // carry no contract event; `turn_end` is emitted by the driver, not derived
      // from a chunk, so the terminal `stopReason` is authoritative.
      return []
  }
}

// ── Capability descriptor and JSON Schema generation ─────────────────────────

/**
 * What a headless runtime advertises at handshake: its protocol version, which
 * lifecycle operations it supports, output modes, and the permission profiles it
 * knows. The ACP capability probe (`AcpCapabilitySnapshot`) is the richer,
 * transport-specific cousin of this; this is the transport-neutral core.
 */
export const headlessCapabilitiesSchema = z.object({
  protocolVersion: z.number().int().positive(),
  operations: z.object({
    new: z.boolean(),
    resume: z.boolean(),
    fork: z.boolean(),
    cancel: z.boolean(),
  }),
  outputModes: z.array(headlessOutputModeSchema).min(1),
  permissionProfiles: z.array(z.string()).min(1),
})
export type HeadlessCapabilities = z.infer<typeof headlessCapabilitiesSchema>

/**
 * The JSON Schema bundle published for external (non-TypeScript) adapters. Every
 * schema here is generated from the same zod declaration the TypeScript types are
 * inferred from — the single-source-of-truth guarantee. `scripts/gen-headless-schema.mts`
 * writes this to `schemas/headless-contract.schema.json`; a test asserts the
 * committed file matches so the two never drift.
 *
 * Consumer rules the published schema commits to:
 *
 * - **`runRequest` is an INPUT contract**, generated with `io: 'input'` so a
 *   zod-defaulted field (`outputMode`, `permissionProfile`) is *optional* in the
 *   JSON Schema — the runtime fills the default. Generating it as an output
 *   schema would mark those `required` and make an external validator reject a
 *   minimal `{ kind, cwd, input }` request the canonical parser accepts.
 * - **`event` / `capabilities` are OUTPUT contracts** (what the runtime emits),
 *   generated as output schemas.
 * - Every definition pins the exact **closed** v1 shape. Forward-compatibility is
 *   a lenient-reader behavior (see the event-envelope note above), not something
 *   strict validation against these schemas provides.
 */
export function headlessContractJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Copse headless automation contract',
    version: HEADLESS_PROTOCOL_VERSION,
    definitions: {
      runRequest: z.toJSONSchema(headlessRunRequestSchema, { io: 'input' }),
      event: z.toJSONSchema(headlessEventSchema),
      permissionProfile: z.toJSONSchema(headlessPermissionProfileSchema, { io: 'input' }),
      capabilities: z.toJSONSchema(headlessCapabilitiesSchema),
    },
  }
}
