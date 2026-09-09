import type { ModelParameters } from '@copse/llm/model-parameters.ts'
import type { CanvasArtefactReference } from './canvas-types.ts'
import type {
  ModelUsage,
  MessageOrigin,
  SubagentSession,
  Thread,
  ThreadReview,
  TranscriptAttachment,
} from './thread-types.ts'
import type { TurnOutcome } from './turn-outcome.ts'
import { type DecisionEvent } from './decision-log.ts'
import { isPromptCause } from './prompt-cause.ts'
import { planArtifactRefs } from './plan-schema.ts'

/**
 * On-disk format for the filesystem-native thread store (issue #644).
 *
 * A thread is a directory whose linear history is an append-only JSONL "spine"
 * (`events.jsonl`), one {@link SpineMessageLine} per finalized message, plus
 * non-message observability lines (`hook_run`, `decision`, Plan Mode `plan`). Prose
 * (message text, reasoning) lives in referenced OKF markdown files; large or
 * opaque content (tool results, tool args, plan revisions) lives in referenced
 * files. This module is pure — no `node:fs`/Electron — so the fidelity
 * round-trip is unit-testable without shims. See {@link foldThread} /
 * {@link explodeMessage}.
 */

/** Bump when the spine line shape changes in a backwards-incompatible way. */
export const SPINE_SCHEMA_VERSION = 1

/** Synchronous content hash (hex). Injected so the pure modules stay Node-free. */
export type HashFn = (input: string) => string

/** Thread metadata persisted in `meta.json` — everything except the messages. */
export type ThreadMeta = Omit<Thread, 'messages'>

/** A reference to a file within the thread directory plus a hash of its logical content. */
export interface ContentRef {
  /** Path relative to the thread directory, e.g. `messages/<id>.md`. */
  ref: string
  /** Hex hash of the *logical* content (the message body / result string), not the file bytes. */
  sha256: string
}

/** A referenced image blob (a data URL stored verbatim in a blob file). */
export interface ImageRef {
  ref: string
  sha256: string
}

/** Transcript metadata stays inline; potentially large text snapshots do not. */
export type SpineTranscriptAttachment = Omit<TranscriptAttachment, 'content'> & {
  content?: ContentRef
}

/** A tool call as persisted on a spine line. `running` is never written. */
export interface SpineToolCall {
  id: string
  name: string
  args: unknown
  status: 'done' | 'error'
  /** null when the tool produced no result; a ref (possibly to empty contents) otherwise. */
  result: ContentRef | null
  editStats?: { additions: number; deletions: number }
  /** ACP tool-call kind (`'execute'`, `'read'`, …) from an external ACP agent. */
  kind?: string
  /** Render `result` as Markdown (external ACP agents author Markdown output). */
  resultFormat?: 'markdown'
  subagent?: SpineSubagentRef
}

/** A nested subagent session; its messages live in `<ref>events.jsonl` + files. */
export interface SpineSubagentRef {
  /** Directory ref, e.g. `subagents/<id>/`. */
  ref: string
  kind: SubagentSession['kind']
  status: SubagentSession['status']
  prompt: string
  summary: string | null
  usage?: ModelUsage
  model?: string
  localFallback?: boolean
  /** Name of the user-authored definition, for `kind: 'custom'`. */
  agentName?: string
  agentColor?: string
}

/** One line of `events.jsonl`: a single finalized message. */
export interface SpineMessageLine {
  v: number
  type: 'message'
  id: string
  role: 'user' | 'assistant' | 'error'
  /** Always set for top-level messages; may be absent on legacy subagent messages. */
  createdAt?: number
  /** The message content OKF file. Always present (body may be empty). */
  content: ContentRef
  reasoning?: ContentRef
  images?: ImageRef[]
  /** Canvas artefacts presented inline with this assistant message. */
  canvasArtefacts?: CanvasArtefactReference[]
  commandSummary?: string
  /** Small-model polish for the turn tool rollup; optional, display-only. */
  toolSummary?: string
  /**
   * Small-model polish for the cross-message run this message anchors;
   * optional, display-only. Absent on every spine written before runs existed,
   * where the derived `Used N tools` label stands in.
   */
  runSummary?: string
  /** Display metadata is inline; text snapshots are referenced blob files. */
  attachments?: SpineTranscriptAttachment[]
  /**
   * Primary-chat model for this assistant message — the concrete route the turn
   * ran on. Optional for legacy spines written before per-message provenance
   * existed.
   */
  model?: string
  /**
   * The picker/requested selection for this message (possibly a dynamic
   * selector like `auto:…`). The resolved route the turn actually ran on lives
   * on {@link SpineMessageLine.model}. Absent on spines written before this was
   * captured.
   */
  requestedModel?: string
  /**
   * Resolved generation parameters the turn ran with — see `Message.parameters`.
   * Absent for a turn that sent none (the common case) and for spines written
   * before they were recorded.
   */
  parameters?: ModelParameters
  /** Terminal state and bounded diagnostics for this turn. */
  turnOutcome?: TurnOutcome
  /** Post-turn review verdict anchored to this message (kept inline — small). */
  review?: ThreadReview
  /**
   * Hook provenance when this turn was started by a hook follow-up (decision
   * 10). Persisted so the transcript can mark a hook-originated turn after a
   * reload; `editedByUser` records that a human edited the hook's text before it
   * dispatched (authorship stays honest). Absent = human-authored.
   */
  origin?: MessageOrigin
  editedByUser?: boolean
  /**
   * Repository state this prompt started from (user messages only), captured at
   * send time. `startingCommit` is the HEAD SHA the turn began on; `dirty`
   * records whether the working tree had uncommitted changes at that moment.
   * Absent outside a git repo or for messages sent through a path that doesn't
   * capture it (e.g. resend).
   */
  startingCommit?: string
  dirty?: boolean
  toolCalls: SpineToolCall[]
}

// The decision summary is owned by the hooks platform in `@copse/agent` (a
// dialect adapter produces it, the spine records it); re-exported under the
// spine's name so existing importers are unchanged.
export type { HookRunDecision as SpineHookRunDecision } from '@copse/agent/hooks/hook-outcome.ts'
import type { HookRunDecision as SpineHookRunDecision } from '@copse/agent/hooks/hook-outcome.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

/**
 * One line of `events.jsonl`: a single hook execution (decision 6 of
 * docs/plans/hooks-and-feature-packs.md). Always-on observability: every hook
 * run — in-process function hooks and spawned command hooks — appends one of
 * these, with raw stdout/stderr captured as blobs for command hooks. Old
 * readers ({@link parseSpine}) skip any non-`message` line, so this type is
 * forward-compatible by construction.
 */
export interface SpineHookRunLine {
  v: number
  type: 'hook_run'
  /** Unique id of this execution; also names the stdout/stderr blobs. */
  id: string
  /** Event name that fired (canonical or dialect, e.g. `beforeShellExecution`). */
  event: string
  /** Stable hook id: the registry id (function hooks) or command string (command hooks). */
  hookId: string
  executor: 'function' | 'command'
  /** Emitting attribution: the agent run (turn) this execution belongs to, when known. */
  turnId?: string
  /** LLM-call index within the run at emission time (0 = before the first call). */
  step?: number
  startedAt: number
  /** Wall-clock duration of the execution. */
  durationMs: number
  /**
   * Process exit code. Command hooks only: `null` when the process was killed
   * (timeout / output cap) or failed to spawn; absent for function hooks.
   */
  exitCode?: number | null
  /**
   * Whether the raw stdout was successfully converted into a hook response.
   * Empty stdout is an intentional no-response (`true`); non-empty non-JSON
   * output (e.g. a stray debug print) is `false` — visible right next to the
   * bytes in the stdout blob. Function hooks return typed outcomes in-process,
   * so they are always `true`.
   */
  parseOk: boolean
  /** Normalized decision summary (parsed form; raw bytes in the stdout blob). */
  decision: SpineHookRunDecision
  /** Error message when a function hook threw (fail-hard: the run still surfaced it). */
  error?: string
  /** Raw stream captures (command hooks; absent for function hooks). */
  stdout?: ContentRef
  stderr?: ContentRef
  /**
   * What the hook was *handed*: the exact stdin bytes for a command hook, the
   * serialized dispatch payload for a function hook. Bounded at capture time —
   * an oversized payload is truncated with a visible marker, never dropped
   * silently. Absent when the payload could not be serialized.
   */
  payload?: ContentRef
  /**
   * What a function hook *returned*, in full: the injected context, agent /
   * user messages, rewritten tool input and halt reason the compact
   * {@link SpineHookRunDecision} only counts characters of. Command hooks have
   * no such blob — their raw response is already the stdout capture. Absent for
   * a run that abstained (nothing to show beyond the counts).
   */
  outcome?: ContentRef
  /** Content-addressed toolset fingerprint hash (see {@link toolsetBlobRef}). */
  toolset?: string
}

/** Plan Mode lifecycle actions recorded on the spine (issue #1080, P1). */
export const PLAN_SPINE_ACTIONS = ['create', 'revise', 'comment', 'approve', 'abandon'] as const
export type PlanSpineAction = (typeof PLAN_SPINE_ACTIONS)[number]

/**
 * One line of `events.jsonl`: a Plan Mode lifecycle event. Artifacts live under
 * `plans/<planId>/`; this line is the append-only commit point (same pattern as
 * `hook_run`). Old readers ({@link parseSpine}) skip non-`message` lines.
 */
export interface SpinePlanLine {
  v: number
  type: 'plan'
  /** Lifecycle action for this append. */
  action: PlanSpineAction
  /** Unique id of this spine event (not the plan id). */
  id: string
  planId: string
  /** Revision touched by create/revise/comment/approve when applicable. */
  revision?: number
  createdAt: number
  /** Revision markdown ref, e.g. `plans/<planId>/revision-2.md`. */
  artifact?: ContentRef
  /** Set when `action` is `comment`. */
  commentId?: string
  /** Set when `action` is `approve`. */
  executionProfileId?: string
  /** Content hash of the approved revision body when `action` is `approve`. */
  contentHash?: string
}

/** Durable host-owned shell authorization record (legacy Guarded YOLO shape). */
export interface SpinePermissionDecisionLine {
  v: number
  type: 'permission_decision'
  id: string
  turnId?: string
  step?: number
  decidedAt: number
  originalCommand: string
  /** Present when a blocking hook rewrote the command before host policy ran. */
  effectiveCommand?: string
  originalMode: 'guarded-yolo'
  effectiveMode: 'guarded-yolo'
  sandboxState: 'project-sandbox' | 'unsandboxed'
  harmDecision: 'allow' | 'prompt' | 'deny'
  policyDecision: 'allow' | 'prompt' | 'deny'
  reasons: string[]
  userResponse: 'approved' | 'declined' | 'not-required'
}

/**
 * Unified control-plane decision on the thread spine (issue #656). Same fields as
 * {@link DecisionEvent}, plus optional `detail` blob (argv / YOLO extras) and
 * turn correlation. Written for user, classifier, hook, and system actors.
 */
export type SpineDecisionLine = DecisionEvent & {
  detail?: ContentRef
  turnId?: string
  step?: number
}

/** Thread-relative path for a decision detail blob. */
export function decisionDetailBlobRef(decisionId: string): string {
  return `blobs/decision-${decisionId}.detail.json`
}

/** Blob refs a decision line points at (kept alive across full rewrites). */
export function decisionBlobRefs(line: SpineDecisionLine): string[] {
  return line.detail ? [line.detail.ref] : []
}

export const MACHINE_CONTINUATION_RESULTS = [
  'completed',
  'duplicate',
  'stale',
  'budget-exhausted',
  'failed',
] as const
export type MachineContinuationResult = (typeof MACHINE_CONTINUATION_RESULTS)[number]

/** Compact machine-continuation audit record; prompts and outputs stay in their existing stores. */
export type SpineMachineContinuationLine = {
  v: number
  type: 'machine_continuation'
  id: string
  operationId: string
  turnTreeId: string
  recordedAt: number
  budgetUsed?: number
} & (
  | { phase: 'started'; result?: never; turnOutcome?: never }
  | { phase: 'finished'; result: MachineContinuationResult; turnOutcome?: TurnOutcome }
)

/** A committed thread-model selection, attributed to its initiating actor. */
export interface SpineModelSelectedLine {
  v: number
  type: 'model_selected'
  id: string
  recordedAt: number
  by: 'user' | 'auto'
  from?: string
  to: string
}

/** Discriminated union of every line type this schema version can write. */
export type SpineLine =
  | SpineMessageLine
  | SpineHookRunLine
  | SpinePlanLine
  | SpinePermissionDecisionLine
  | SpineDecisionLine
  | SpineMachineContinuationLine
  | SpineModelSelectedLine

/** Thread-relative ref of the content-addressed toolset fingerprint blob. */
export function toolsetBlobRef(hash: string): string {
  return `blobs/toolset-${hash}.json`
}

/** Blob refs a hook_run line points at (kept alive across full rewrites). */
export function hookRunBlobRefs(line: SpineHookRunLine): string[] {
  const refs: string[] = []
  if (line.stdout) refs.push(line.stdout.ref)
  if (line.stderr) refs.push(line.stderr.ref)
  if (line.payload) refs.push(line.payload.ref)
  if (line.outcome) refs.push(line.outcome.ref)
  if (line.toolset) refs.push(toolsetBlobRef(line.toolset))
  return refs
}

export function serializeSpineLine(line: SpineLine): string {
  return JSON.stringify(line)
}

/** Keys of `T` that must be present; an optional key is excluded. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T]

/** Keys of `T` that may be absent. */
type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>

/**
 * A check for one field. Normally it must *prove* the field's declared type, so
 * the compiler rejects a body that establishes something else. Naming the field
 * in a table's `Loose` parameter downgrades it to a plain boolean: the check
 * still runs, but it is no longer claimed to establish the declared type.
 */
type FieldCheck<T, K extends keyof T, Loose> = K extends Loose
  ? (value: unknown) => boolean
  : (value: unknown) => value is T[K]

/**
 * One check per required field of `T`.
 *
 * Two things are enforced by the compiler here, and together they are why this
 * file no longer hand-writes an `is` per line type. A missing entry fails with
 * "Property 'x' is missing"; an entry whose body proves the wrong thing fails
 * with "Type predicate 'x is string' is not assignable to 'value is number'".
 * Adding a required field to a spine interface without teaching the parser to
 * validate it is therefore a build error, not a silent widening of what
 * {@link parseSpineLine} hands back as typed data.
 *
 * Each check is a bare arrow with no annotation, so TypeScript infers its
 * predicate from the body (`docs/type-safety.md`) rather than taking an
 * assertion's word for it.
 *
 * `Loose` names the fields this parser deliberately does not fully prove — the
 * tolerance `docs/thread-store-format.md` requires. Putting it in the type
 * makes every such field appear in the table's declaration, so the exceptions
 * are read off the source rather than inferred from what is missing. Widening
 * one is a compatibility decision, not a tidy-up: a line this parser starts
 * rejecting drops out of `preservedRefs`, and `pruneStaleFiles` then deletes
 * the blob files it still references.
 */
type RequiredFieldChecks<T, Loose extends keyof T = never> = {
  [K in RequiredKeys<T>]: FieldCheck<T, K, Loose>
}

/**
 * Checks for optional fields, applied only when the field is present — the
 * `x === undefined || check(x)` clauses these replace. A field with no entry is
 * not inspected at all, which is the pre-existing behaviour for most of them.
 */
type OptionalFieldChecks<T, Loose extends keyof T = never> = {
  [K in OptionalKeys<T>]?: K extends Loose
    ? (value: unknown) => boolean
    : (value: unknown) => value is Exclude<T[K], undefined>
}

/**
 * The file's one `is` assertion, replacing the nine that used to sit one per
 * line type. It claims exactly what the tables establish: every required field
 * present and of its declared type, and every optional field that is present
 * and has a check passing it.
 */
function fieldsMatch<T, Loose extends keyof T>(
  value: unknown,
  required: RequiredFieldChecks<T, Loose>,
  optional: OptionalFieldChecks<T, Loose>,
): value is T {
  if (!isRecord(value)) return false
  for (const [key, check] of Object.entries<(value: unknown) => boolean>(required)) {
    if (!check(value[key])) return false
  }
  for (const [key, check] of Object.entries<((value: unknown) => boolean) | undefined>(optional)) {
    if (check && value[key] !== undefined && !check(value[key])) return false
  }
  return true
}

/**
 * Check one line against its field tables, plus any rule spanning two fields.
 *
 * Running the cross-field rule here rather than as a trailing `&&` at the call
 * site is what keeps each line predicate a single expression — the shape
 * TypeScript infers a predicate from, and so the shape it checks rather than
 * takes on trust. The rule reads the *raw* record, never the narrowed line: a
 * correlated type like {@link SpineMachineContinuationLine} declares
 * `result?: never` on its `started` arm, so a rule handed the narrowed value
 * would be told the field it exists to inspect cannot be there.
 */
function matchesLine<T, Loose extends keyof T = never>(
  value: unknown,
  required: RequiredFieldChecks<T, Loose>,
  optional: OptionalFieldChecks<T, Loose> = {},
  crossField?: (line: Record<string, unknown>) => boolean,
): value is T {
  if (!isRecord(value)) return false
  if (crossField && !crossField(value)) return false
  return fieldsMatch(value, required, optional)
}

const CONTENT_REF_FIELDS: RequiredFieldChecks<ContentRef> = {
  ref: (value) => typeof value === 'string',
  sha256: (value) => typeof value === 'string',
}

export const isContentRef: (value: unknown) => value is ContentRef = (value) =>
  matchesLine(value, CONTENT_REF_FIELDS)

const MESSAGE_LINE_FIELDS: RequiredFieldChecks<SpineMessageLine, 'toolCalls'> = {
  v: (value) => typeof value === 'number',
  type: (value) => value === 'message',
  id: (value) => typeof value === 'string',
  role: (value) => value === 'user' || value === 'assistant' || value === 'error',
  content: isContentRef,
  // Absent on legacy lines written before tool calls were persisted, and the
  // elements have never been validated. `parseSpineLine` substitutes `[]` for
  // an absent or non-array value immediately after this check, which is what
  // makes the declared `SpineToolCall[]` true of what the caller receives.
  toolCalls: (value) => value === undefined || Array.isArray(value),
}

const MESSAGE_LINE_OPTIONAL: OptionalFieldChecks<SpineMessageLine, 'canvasArtefacts'> = {
  // Only `title` is inspected; the rest of an artefact is passed through as the
  // renderer's problem, exactly as before.
  canvasArtefacts: (value) =>
    Array.isArray(value) &&
    value.every((artefact) => isRecord(artefact) && typeof artefact['title'] === 'string'),
}

const isSpineMessageLine: (value: unknown) => value is SpineMessageLine = (value) =>
  matchesLine(value, MESSAGE_LINE_FIELDS, MESSAGE_LINE_OPTIONAL)

const HOOK_RUN_FIELDS: RequiredFieldChecks<SpineHookRunLine, 'decision'> = {
  v: (value) => typeof value === 'number',
  type: (value) => value === 'hook_run',
  id: (value) => typeof value === 'string',
  event: (value) => typeof value === 'string',
  hookId: (value) => typeof value === 'string',
  executor: (value) => value === 'function' || value === 'command',
  startedAt: (value) => typeof value === 'number',
  durationMs: (value) => typeof value === 'number',
  parseOk: (value) => typeof value === 'boolean',
  // The hooks platform owns `HookRunDecision`'s shape, and this package has
  // never validated past "it is an object": a spine written by a newer Copse
  // can carry decision fields this one has no schema for, and rejecting those
  // lines would delete the stdout/stderr blobs they reference.
  decision: isRecord,
}

const isSpineHookRunLine: (value: unknown) => value is SpineHookRunLine = (value) =>
  matchesLine(value, HOOK_RUN_FIELDS)

const DECISION_LINE_FIELDS: RequiredFieldChecks<SpineDecisionLine> = {
  v: (value) => typeof value === 'number',
  type: (value) => value === 'decision',
  id: (value) => typeof value === 'string',
  at: (value) => typeof value === 'number',
  kind: (value) => typeof value === 'string',
  subject: (value) => typeof value === 'string',
  actor: (value) =>
    value === 'user' || value === 'classifier' || value === 'hook' || value === 'system',
  verdict: (value) =>
    value === 'approved' ||
    value === 'denied' ||
    value === 'allowed' ||
    value === 'blocked' ||
    value === 'ask' ||
    value === 'classified' ||
    value === 'timeout' ||
    value === 'cancelled' ||
    value === 'deferred',
}

const DECISION_LINE_OPTIONAL: OptionalFieldChecks<SpineDecisionLine, 'cause'> = {
  detail: isContentRef,
  cause: isPromptCause,
  toolCallId: (value) => typeof value === 'string',
  turnId: (value) => typeof value === 'string',
  step: (value) => typeof value === 'number',
}

const isSpineDecisionLine: (value: unknown) => value is SpineDecisionLine = (value) =>
  matchesLine(value, DECISION_LINE_FIELDS, DECISION_LINE_OPTIONAL)

const PERMISSION_DECISION_FIELDS: RequiredFieldChecks<SpinePermissionDecisionLine, 'reasons'> = {
  v: (value) => typeof value === 'number',
  type: (value) => value === 'permission_decision',
  id: (value) => typeof value === 'string',
  decidedAt: (value) => typeof value === 'number',
  originalCommand: (value) => typeof value === 'string',
  originalMode: (value) => value === 'guarded-yolo',
  effectiveMode: (value) => value === 'guarded-yolo',
  sandboxState: (value) => value === 'project-sandbox' || value === 'unsandboxed',
  harmDecision: (value) => value === 'allow' || value === 'prompt' || value === 'deny',
  policyDecision: (value) => value === 'allow' || value === 'prompt' || value === 'deny',
  reasons: (value) => Array.isArray(value) && value.every((reason) => typeof reason === 'string'),
  userResponse: (value) => value === 'approved' || value === 'declined' || value === 'not-required',
}

const isSpinePermissionDecisionLine: (value: unknown) => value is SpinePermissionDecisionLine = (
  value,
) => matchesLine(value, PERMISSION_DECISION_FIELDS)

const isMachineContinuationResult: (value: unknown) => value is MachineContinuationResult = (
  value,
) =>
  value === 'completed' ||
  value === 'duplicate' ||
  value === 'stale' ||
  value === 'budget-exhausted' ||
  value === 'failed'

const TURN_OUTCOME_FIELDS: RequiredFieldChecks<TurnOutcome, 'stopReason'> = {
  status: (value) => value === 'completed' || value === 'failed' || value === 'cancelled',
  // Declared as a nine-literal union, but the spine has only ever validated it
  // as a string — and this is the field that made the old predicate's
  // `value is TurnOutcome` a lie rather than merely incomplete. Tightening it
  // is a compatibility decision, not a fix: a newer Copse can write a stop
  // reason this build has no literal for, and a `machine_continuation` line
  // rejected over it takes its turn outcome out of the transcript.
  stopReason: (value) => typeof value === 'string',
  source: (value) =>
    value === 'provider' || value === 'host' || value === 'user' || value === 'hook',
  executor: (value) =>
    value === 'local' || value === 'acp' || value === 'remote' || value === 'plugin',
  provider: (value) => typeof value === 'string',
  model: (value) => typeof value === 'string',
  endedAt: (value) => typeof value === 'number',
}

const isTurnOutcome: (value: unknown) => value is TurnOutcome = (value) =>
  matchesLine(value, TURN_OUTCOME_FIELDS)

const MACHINE_CONTINUATION_FIELDS: RequiredFieldChecks<SpineMachineContinuationLine, 'result'> = {
  v: (value) => typeof value === 'number',
  type: (value) => value === 'machine_continuation',
  id: (value) => typeof value === 'string',
  operationId: (value) => typeof value === 'string',
  turnTreeId: (value) => typeof value === 'string',
  recordedAt: (value) => typeof value === 'number',
  // `phase` is proved here; the correlation between it and `result` /
  // `turnOutcome` is a cross-field rule, checked in `isSpineMachineContinuationLine`
  // below because no per-field check can see two fields at once.
  phase: (value) => value === 'started' || value === 'finished',
  // Correlated with `phase`, so no per-field check can decide it; the real rule
  // is `machineContinuationPhaseAgrees`, run below as the cross-field pass.
  result: () => true,
}

const MACHINE_CONTINUATION_OPTIONAL: OptionalFieldChecks<
  SpineMachineContinuationLine,
  'budgetUsed'
> = {
  budgetUsed: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0,
}

/**
 * `started` carries no result; `finished` carries one and may carry a turn
 * outcome. That disjunction is the one rule here that spans fields, so it stays
 * an explicit clause — and because a `&&` chain is not a form TypeScript can
 * infer a predicate from, the narrowing half is done first and the correlation
 * is checked against the already-narrowed value.
 */
const isSpineMachineContinuationLine: (value: unknown) => value is SpineMachineContinuationLine = (
  value,
) =>
  matchesLine(
    value,
    MACHINE_CONTINUATION_FIELDS,
    MACHINE_CONTINUATION_OPTIONAL,
    machineContinuationPhaseAgrees,
  )

function machineContinuationPhaseAgrees(line: Record<string, unknown>): boolean {
  return line['phase'] === 'started'
    ? line['result'] === undefined && line['turnOutcome'] === undefined
    : isMachineContinuationResult(line['result']) &&
        (line['turnOutcome'] === undefined || isTurnOutcome(line['turnOutcome']))
}

const MODEL_SELECTED_FIELDS: RequiredFieldChecks<SpineModelSelectedLine> = {
  v: (value) => typeof value === 'number',
  type: (value) => value === 'model_selected',
  id: (value) => typeof value === 'string',
  recordedAt: (value) => typeof value === 'number',
  by: (value) => value === 'user' || value === 'auto',
  to: (value) => typeof value === 'string',
}

const MODEL_SELECTED_OPTIONAL: OptionalFieldChecks<SpineModelSelectedLine> = {
  from: (value) => typeof value === 'string',
}

const isSpineModelSelectedLine: (value: unknown) => value is SpineModelSelectedLine = (value) =>
  matchesLine(value, MODEL_SELECTED_FIELDS, MODEL_SELECTED_OPTIONAL)

const isPlanSpineAction: (value: unknown) => value is PlanSpineAction = (value) =>
  value === 'create' ||
  value === 'revise' ||
  value === 'comment' ||
  value === 'approve' ||
  value === 'abandon'

const PLAN_LINE_FIELDS: RequiredFieldChecks<SpinePlanLine> = {
  v: (value) => typeof value === 'number',
  type: (value) => value === 'plan',
  id: (value) => typeof value === 'string',
  planId: (value) => typeof value === 'string',
  createdAt: (value) => typeof value === 'number',
  action: isPlanSpineAction,
}

const PLAN_LINE_OPTIONAL: OptionalFieldChecks<SpinePlanLine> = {
  revision: (value) => typeof value === 'number',
  artifact: isContentRef,
  commentId: (value) => typeof value === 'string',
  executionProfileId: (value) => typeof value === 'string',
  contentHash: (value) => typeof value === 'string',
}

const isSpinePlanLine: (value: unknown) => value is SpinePlanLine = (value) =>
  matchesLine(value, PLAN_LINE_FIELDS, PLAN_LINE_OPTIONAL)

/** Parse one spine line into the {@link SpineLine} union. Null on malformed/unknown. */
export function parseSpineLine(raw: string): SpineLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed['id'] !== 'string') return null
  const type = parsed['type']
  if (type === 'message' && isSpineMessageLine(parsed)) {
    // Tolerate an absent toolCalls array (forward/backward compatibility).
    if (!Array.isArray(parsed.toolCalls)) parsed.toolCalls = []
    return parsed
  }
  if (type === 'plan' && isSpinePlanLine(parsed)) return parsed

  if (type === 'hook_run' && isSpineHookRunLine(parsed)) return parsed
  if (type === 'decision' && isSpineDecisionLine(parsed)) return parsed
  if (type === 'permission_decision' && isSpinePermissionDecisionLine(parsed)) return parsed
  if (type === 'machine_continuation' && isSpineMachineContinuationLine(parsed)) return parsed
  if (type === 'model_selected' && isSpineModelSelectedLine(parsed)) return parsed

  return null
}

/** Serialize a full `events.jsonl` body (trailing newline included). */
export function serializeSpine(lines: SpineLine[]): string {
  return lines.map(serializeSpineLine).join('\n') + (lines.length > 0 ? '\n' : '')
}

/**
 * Parse a full `events.jsonl` body into *message* lines only, skipping blank,
 * malformed, and non-`message` lines. This is the reader every fold/display
 * path uses, which is exactly what keeps old readers forward-tolerant of new
 * line types (decision 6): a hook_run line is invisible to them.
 */
export function parseSpine(raw: string): SpineMessageLine[] {
  const out: SpineMessageLine[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseSpineLine(line)
    if (parsed?.type === 'message') out.push(parsed)
  }
  return out
}

/**
 * One physical `events.jsonl` line kept verbatim alongside its parsed form
 * (null when the line is not a known {@link SpineLine}). Writers that rewrite
 * the file use this so lines they don't understand — future line types, not
 * just hook_run — survive byte-for-byte instead of being silently dropped.
 */
export interface SpineEntry {
  /** The verbatim line (no trailing newline). */
  raw: string
  line: SpineLine | null
}

/** Parse a full `events.jsonl` body into entries, preserving unknown lines. */
export function parseSpineEntries(raw: string): SpineEntry[] {
  const out: SpineEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    out.push({ raw: line, line: parseSpineLine(line) })
  }
  return out
}

/** Serialize entries back to an `events.jsonl` body (trailing newline included). */
export function serializeSpineEntries(entries: SpineEntry[]): string {
  return entries.map((e) => e.raw).join('\n') + (entries.length > 0 ? '\n' : '')
}

/**
 * Rebuild an `events.jsonl` body from a freshly exploded message spine while
 * preserving every non-message line already in the file (hook_run records and
 * any future line type). This is the full-save round-trip decision 6 requires:
 * `writeThread` regenerates the spine from `thread.messages` alone, so without
 * this merge an independently appended hook_run line would vanish on the next
 * save.
 *
 * Read-merge-write was chosen over carrying non-message lines in memory: the
 * in-memory `Thread` travels through IPC to the renderer, and widening that
 * surface for write-only observability records would leak main-process
 * persistence details everywhere. Merging at the one place that rewrites the
 * file keeps hook_run lines a pure main-process concern.
 *
 * Ordering: each preserved line stays anchored to the message line that
 * preceded it in the old file (hook runs are appended mid-turn, before their
 * turn's messages finalize). Lines whose anchor message was deleted are kept
 * at the end rather than dropped.
 *
 * `preservedRefs` lists blob refs the preserved lines reference, so the
 * caller's stale-file pruning keeps them alive. Unknown future line types are
 * preserved verbatim but cannot declare refs; a future type that references
 * blobs must extend this collection.
 */
export function rebuildSpinePreservingNonMessageLines(
  existingRaw: string,
  messages: SpineMessageLine[],
): { body: string; preservedRefs: string[] } {
  interface Preserved {
    raw: string
    anchor: string | null
  }
  const preserved: Preserved[] = []
  const preservedRefs: string[] = []
  let lastMessageId: string | null = null
  for (const entry of parseSpineEntries(existingRaw)) {
    if (entry.line?.type === 'message') {
      lastMessageId = entry.line.id
      continue
    }
    preserved.push({ raw: entry.raw, anchor: lastMessageId })
    if (entry.line?.type === 'hook_run') preservedRefs.push(...hookRunBlobRefs(entry.line))
    if (entry.line?.type === 'decision') preservedRefs.push(...decisionBlobRefs(entry.line))
    if (entry.line?.type === 'plan') preservedRefs.push(...planArtifactRefs(entry.line.artifact))
  }
  if (preserved.length === 0) {
    return { body: serializeSpine(messages), preservedRefs }
  }

  const byAnchor = new Map<string | null, string[]>()
  for (const p of preserved) {
    const list = byAnchor.get(p.anchor)
    if (list) list.push(p.raw)
    else byAnchor.set(p.anchor, [p.raw])
  }

  const out: string[] = [...(byAnchor.get(null) ?? [])]
  byAnchor.delete(null)
  for (const message of messages) {
    out.push(serializeSpineLine(message))
    const anchored = byAnchor.get(message.id)
    if (anchored) {
      out.push(...anchored)
      byAnchor.delete(message.id)
    }
  }
  // Anchors deleted from the message set: keep their lines at the end.
  for (const rest of byAnchor.values()) out.push(...rest)

  return { body: out.join('\n') + '\n', preservedRefs }
}
