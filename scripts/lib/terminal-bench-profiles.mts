import { createHash } from 'node:crypto'
import type {
  ReasoningCheckpointPolicy,
  ReasoningCircleDetectorOptions,
} from '@copse/agent/reasoning-circle-detector.ts'
import { keyOf } from '@copse/std/member-of.ts'
import { z } from 'zod'

export const TERMINAL_BENCH_PROFILE_IDS = ['main-legacy', 'pr-1149', 'product-aligned'] as const

export type TerminalBenchProfileId = (typeof TERMINAL_BENCH_PROFILE_IDS)[number]
export const TERMINAL_BENCH_PROFILE_VERSIONED_IDS = [
  'main-legacy@1',
  'main-legacy@2',
  'pr-1149@1',
  'product-aligned@1',
  'product-aligned@2',
  'product-aligned@3',
  'product-aligned@4',
] as const

export type TerminalBenchProfileVersionedId = (typeof TERMINAL_BENCH_PROFILE_VERSIONED_IDS)[number]
export type TerminalBenchProfileSelectionId =
  | TerminalBenchProfileId
  | TerminalBenchProfileVersionedId

export type TerminalBenchWriteFilePolicy = 'none' | 'app-absolute' | 'workspace-relative'
export type TerminalBenchReasoningPolicy = 'fixed-cap' | 'circle-gated-2k-checkpoints-v1'

/**
 * The `runAgentLoop` settings a profile runs with. The host passes these values
 * verbatim, so a profile — not whatever the product constants happen to be at
 * dispatch time — decides how its streams are bounded.
 *
 * `reasoningCircleDetector` is different: `runAgentLoop` always uses the
 * product's `DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS`, so this field records
 * the thresholds the profile was defined against. The drift test in
 * `terminal-bench-profiles.test.ts` fails when a runnable profile's recorded
 * thresholds no longer match the product, because the host cannot pin them.
 */
export interface TerminalBenchLoopSettings {
  /** Default per-stream cap; `COPSE_TERMINAL_MAX_STREAM_OUTPUT_TOKENS` may override it. */
  maxStreamOutputTokens: number
  /** Default recovery-stream cap; `COPSE_TERMINAL_REASONING_RECOVERY_MAX_STREAM_OUTPUT_TOKENS` may override it. */
  reasoningRunawayRecoveryOutputTokens: number
  reasoningRunawayTextToleranceChars: number
  allowForcedTextEscalation: boolean
  adaptiveExtensions: boolean
  reasoningCheckpointPolicy: Readonly<ReasoningCheckpointPolicy> | null
  reasoningCircleDetector: Readonly<ReasoningCircleDetectorOptions> | null
}

const positiveInteger = z.number().int().positive()

/**
 * Effective run-level settings the agent reports with every trial. They come
 * from the environment, not from the profile, so they are recorded per trial
 * rather than folded into a profile hash that historical capsules pin.
 */
export const TERMINAL_BENCH_RUNTIME_CONFIGURATION_SCHEMA = z
  .object({
    maxSteps: positiveInteger,
    maxLlmCalls: positiveInteger,
    maxContextTokens: positiveInteger,
    maxStreamOutputTokens: positiveInteger,
    reasoningRunawayRecoveryOutputTokens: positiveInteger,
    maxCommandTimeoutSec: positiveInteger,
  })
  .strict()

export type TerminalBenchRuntimeConfiguration = z.infer<
  typeof TERMINAL_BENCH_RUNTIME_CONFIGURATION_SCHEMA
>

export interface TerminalBenchStreamCapOverrides {
  maxStreamOutputTokens?: number
  reasoningRunawayRecoveryOutputTokens?: number
}

export interface TerminalBenchProfile {
  id: TerminalBenchProfileId
  version: 1 | 2 | 3 | 4
  versionedId: TerminalBenchProfileVersionedId
  contentHash: string
  systemPrompt: string
  reasoningRunawayRecoveryNudge: string
  stuckToolRecoveryNudge: string
  exposesWriteFile: boolean
  writeFilePolicy: TerminalBenchWriteFilePolicy
  forcesRequestedOutputRecovery: boolean
  warnsOnValidationEvidence: boolean
  nonzeroShellResultIsError: boolean
  reasoningPolicy: TerminalBenchReasoningPolicy
  loop: TerminalBenchLoopSettings
  /**
   * Why the profile can no longer be run, or null when it can. A retired
   * profile still resolves so historical capsules keep their identity, but its
   * hash does not describe what the current host would do with it.
   */
  retirement: string | null
  /** Run one read-only /tests and /app probe before the first model turn. */
  preflightProbe: boolean
}

export const MAIN_LEGACY_REASONING_RUNAWAY_RECOVERY_NUDGE =
  'You spent the entire response planning without taking action, and it was cut off. ' +
  'Stop planning and use run_shell now to make concrete progress: produce or update the requested deliverable, then validate it. ' +
  'Do not repeat an inspection command whose result is already above, and do not merely describe the solution.'

export const MAIN_LEGACY_STUCK_TOOL_RECOVERY_NUDGE =
  'You have spent many turns inspecting or experimenting without completing the target. ' +
  'Stop broad investigation and use the evidence already gathered. Your next run_shell command must produce or update the requested deliverable, whether it is code, configuration, data, or a recovered artifact; ' +
  'do not run another ls, find, grep, sed, cat, or other read-only inspection first. ' +
  'After that edit, run the relevant verifier tests from /tests when available and iterate from the result.'

export const MAIN_LEGACY_SYSTEM_PROMPT = `You are an autonomous terminal agent working inside a persistent task environment.
Use run_shell to inspect the environment, edit files, and validate your work. Commands run in the same environment and their effects persist. Start by checking /tests directly; when it is readable, inspect its relevant verifier tests before implementing and run them before finishing. Treat /tests as authoritative over similarly named files elsewhere, including /app/tests. Work directly on the task; do not merely explain a possible solution. Prefer concrete action after brief inspection: create a draft, test it, and iterate instead of repeatedly reconsidering the plan. Before installing dependencies, check for existing lightweight tools and use the task's local evidence first; do not download large optional packages or model weights unless the verifier requires them and no smaller approach can solve the task. Preserve original inputs before opening damaged, forensic, or stateful data with a program that may checkpoint, recover, migrate, or rewrite it. While iterating, never move, delete, or overwrite original task inputs: work on copies and perform required final moves only after validation. Keep large inputs in files and reuse or edit existing scripts instead of embedding the same data in successive shell commands. Check file sizes and use targeted search or bounded ranges for large source, documentation, and log files; do not print them wholesale. Bound expensive searches to a small representative range first, then expand only when the result justifies it. Avoid long sleep commands while waiting for work: use short bounded polls and make progress between checks. Recover from failed commands, keep verification focused, and continue until the requested outcome is complete or you have exhausted practical approaches. There is no user available for follow-up questions.`

export const MAIN_LEGACY_V2_SYSTEM_PROMPT = MAIN_LEGACY_SYSTEM_PROMPT.replace(
  'Start by checking /tests directly; when it is readable, inspect its relevant verifier tests before implementing and run them before finishing.',
  'The task message ends with an environment_preflight block listing /tests and /app and quoting readable /tests files; use it instead of searching for those facts again. When it reports /tests missing or unreadable, accept that and do not search the filesystem for verifier files. When /tests is readable, inspect its relevant verifier tests before implementing and run them before finishing.',
)

export const PR_1149_REASONING_RUNAWAY_RECOVERY_NUDGE =
  'You spent the entire response planning without taking action, and it was cut off. ' +
  'Stop planning and call write_file now for the exact output path requested in the original task, not an analysis, helper, or test file. ' +
  'If the exact solution is uncertain, write the best current candidate to that target. Do not issue another run_shell inspection or merely describe the solution.'

export const PR_1149_STUCK_TOOL_RECOVERY_NUDGE =
  'You have spent many turns inspecting or experimenting without completing the target. ' +
  'Stop broad investigation and use the evidence already gathered. Your next tool call must be write_file for the exact output path requested in the original task, whether it is code, configuration, data, or a recovered artifact. ' +
  'Do not substitute another analysis, helper, or test file. If the exact answer is uncertain, write the best current candidate to the requested target now; do not run another inspection first. ' +
  'After that edit, use /tests only if you already found it readable. If /tests was absent, never create or modify it and do not search for hidden verifier files again; run a task-local checker with its actual test runner or create a focused self-test, then iterate from the result.'

export const PR_1149_SYSTEM_PROMPT = `You are an autonomous terminal agent working inside a persistent task environment.
A validation command that exits nonzero or emits a traceback or unhandled exception has failed even if later output says tests passed. Assert every invariant named by the task rather than checking only completion; for concurrency limits, instrument the peak active count and fail the checker if it exceeds the limit.
Use run_shell to inspect the environment and validate work, and use write_file to create or replace text files. Commands and writes run in the same environment and their effects persist. Probe /tests once at the start. When it is readable, inspect its relevant verifier tests before implementing, run them before finishing, and treat them as authoritative over similarly named files elsewhere, including /app/tests. When /tests is absent or unreadable, accept that it is unavailable during the agent phase: do not search the filesystem for hidden verifier copies or retry the path later. Never create or modify /tests, even when a task-local checker references it; fabricating a verifier path invalidates the result. Instead use task-provided files and checkers in the workspace. Identify a checker's intended runner before trusting it: for example, a Python file that only defines test functions must be run with pytest, and a silent exit that ran no assertions or collected no tests is not verification. Match validation to the boundary named by the task: for process signals, cancellation, concurrency, filesystems, or networks, exercise the real boundary rather than treating an in-process substitute as equivalent; for example, send a real signal to a subprocess when validating signal cleanup. Work directly on the task; do not merely explain a possible solution. As soon as the requested target path and format are known, call write_file to create a runnable or provisional deliverable at that exact path, then test it and iterate. An analysis, helper, or test file is not a substitute for the output named in the task. For exact-output tasks, write the best current candidate early and replace it as evidence improves; never leave the requested path absent while continuing a long analysis. Keep experiments aimed at testing a working hypothesis instead of repeatedly reconsidering the plan. Before installing dependencies, check for existing lightweight tools and use the task's local evidence first; do not download large optional packages or model weights unless the verifier requires them and no smaller approach can solve the task. Preserve original inputs before opening damaged, forensic, or stateful data with a program that may checkpoint, recover, migrate, or rewrite it. While iterating, never move, delete, or overwrite original task inputs: work on copies and perform required final moves only after validation. Keep large inputs in files and reuse or edit existing scripts instead of embedding the same data in successive shell commands. If analysis needs more than one substantial shell snippet, save a reusable helper script and revise it. Check file sizes and use targeted search or bounded ranges for large source, documentation, and log files; do not print them wholesale. Bound expensive searches to a small representative range first, then expand only when the result justifies it. Avoid long sleep commands while waiting for work: use short bounded polls and make progress between checks. Recover from failed commands, keep verification focused, and continue until the requested outcome is complete or you have exhausted practical approaches. There is no user available for follow-up questions.`

const PRODUCT_ALIGNED_REASONING_RUNAWAY_RECOVERY_NUDGE =
  'Your response was cut off while planning. Use an available tool now to make concrete progress, then verify the result.'

const PRODUCT_ALIGNED_STUCK_TOOL_RECOVERY_NUDGE =
  'Use the evidence already gathered to edit the deliverable now, then run a focused validation and iterate from its result.'

export const PRODUCT_ALIGNED_V1_SYSTEM_PROMPT = `You are an autonomous coding agent in a persistent task environment.
Use run_shell to inspect and validate the workspace, and write_file to create or replace text files under /app. Make concrete edits after brief inspection, run focused validation, and continue until the requested outcome is complete or practical approaches are exhausted. Commands that fail are reported as tool errors; diagnose them rather than treating their output as success. There is no user available for follow-up questions.`

export const PRODUCT_ALIGNED_SYSTEM_PROMPT = `You are an autonomous coding agent in a persistent task environment.
Working directory: {WORKSPACE_ROOT}
Use run_shell to inspect and validate the workspace, and write_file with paths relative to the working directory to create or replace text files. Make concrete edits after brief inspection, run focused validation, and continue until the requested outcome is complete or practical approaches are exhausted. Commands that fail are reported as tool errors; diagnose them rather than treating their output as success. There is no user available for follow-up questions.`

interface LegacyHashDefinition {
  id: TerminalBenchProfileId
  version: 1
  versionedId: 'main-legacy@1' | 'pr-1149@1' | 'product-aligned@1'
  systemPrompt: string
  reasoningRunawayRecoveryNudge: string
  stuckToolRecoveryNudge: string
  exposesWriteFile: boolean
  forcesRequestedOutputRecovery: boolean
  warnsOnValidationEvidence: boolean
  nonzeroShellResultIsError: boolean
}

type ProfileDefinition = Omit<TerminalBenchProfile, 'contentHash' | 'preflightProbe'> & {
  preflightProbe?: true
  hashPayload: unknown
}

/**
 * Loop settings every profile before v4 ran with. They were hard-coded in the
 * host rather than declared by the profile, so the v1–v3 hashes never covered
 * them; those hashes stay frozen because retained capsules reference them.
 */
const FIXED_CAP_LOOP: TerminalBenchLoopSettings = {
  maxStreamOutputTokens: 2_048,
  reasoningRunawayRecoveryOutputTokens: 4_096,
  reasoningRunawayTextToleranceChars: 256,
  allowForcedTextEscalation: false,
  adaptiveExtensions: false,
  reasoningCheckpointPolicy: null,
  reasoningCircleDetector: null,
}

/**
 * Circle-detector thresholds in force when product-aligned@4 was defined
 * (`DEFAULT_REASONING_CIRCLE_DETECTOR_OPTIONS`, after #1242 and #1413).
 */
const CIRCLE_DETECTOR_V1: Readonly<ReasoningCircleDetectorOptions> = {
  minRepeatedBlockChars: 120,
  minRepeatedSentenceChars: 80,
  repeatLimit: 3,
  planWindowItems: 3,
  maxListItems: 100,
  minRepeatedTailChars: 40,
  maxRepeatedTailChars: 2_000,
  minRepeatedTurnChars: 24,
}

/**
 * The product reasoning-checkpoint policy (#1204, plus #1242's trailing cap)
 * with Terminal-Bench's 2K visible-answer ceiling.
 */
const CHECKPOINTED_LOOP: TerminalBenchLoopSettings = {
  ...FIXED_CAP_LOOP,
  reasoningCheckpointPolicy: {
    intervalTokens: 2_048,
    maxNonReasoningTokens: 2_048,
    maxInitialTokens: 32_000,
    maxRecoveryTokens: 4_096,
    maxTrailingReasoningTokens: 4_096,
  },
  reasoningCircleDetector: CIRCLE_DETECTOR_V1,
}

function legacyDefinition(
  definition: LegacyHashDefinition,
  writeFilePolicy: TerminalBenchWriteFilePolicy,
): ProfileDefinition {
  return {
    ...definition,
    writeFilePolicy,
    reasoningPolicy: 'fixed-cap',
    loop: FIXED_CAP_LOOP,
    retirement: null,
    hashPayload: definition,
  }
}

const MAIN_LEGACY_V1 = legacyDefinition(
  {
    id: 'main-legacy',
    version: 1,
    versionedId: 'main-legacy@1',
    systemPrompt: MAIN_LEGACY_SYSTEM_PROMPT,
    reasoningRunawayRecoveryNudge: MAIN_LEGACY_REASONING_RUNAWAY_RECOVERY_NUDGE,
    stuckToolRecoveryNudge: MAIN_LEGACY_STUCK_TOOL_RECOVERY_NUDGE,
    exposesWriteFile: false,
    forcesRequestedOutputRecovery: false,
    warnsOnValidationEvidence: false,
    nonzeroShellResultIsError: false,
  },
  'none',
)

const MAIN_LEGACY_V2_BASE = {
  id: 'main-legacy' as const,
  version: 2 as const,
  versionedId: 'main-legacy@2' as const,
  systemPrompt: MAIN_LEGACY_V2_SYSTEM_PROMPT,
  reasoningRunawayRecoveryNudge: MAIN_LEGACY_REASONING_RUNAWAY_RECOVERY_NUDGE,
  stuckToolRecoveryNudge: MAIN_LEGACY_STUCK_TOOL_RECOVERY_NUDGE,
  exposesWriteFile: false,
  forcesRequestedOutputRecovery: false,
  warnsOnValidationEvidence: false,
  nonzeroShellResultIsError: false,
}

const MAIN_LEGACY_V2: ProfileDefinition = {
  ...MAIN_LEGACY_V2_BASE,
  writeFilePolicy: 'none',
  reasoningPolicy: 'fixed-cap',
  preflightProbe: true,
  loop: FIXED_CAP_LOOP,
  retirement: null,
  hashPayload: {
    hashSchema: 4,
    profile: MAIN_LEGACY_V2_BASE,
    implementation: {
      bridgeProtocol: 'newline-delimited-json-v1',
      preflight: 'readonly-tests-app-probe-8k-appended-to-first-user-message-v1',
    },
  },
}

const PR_1149_V1 = legacyDefinition(
  {
    id: 'pr-1149',
    version: 1,
    versionedId: 'pr-1149@1',
    systemPrompt: PR_1149_SYSTEM_PROMPT,
    reasoningRunawayRecoveryNudge: PR_1149_REASONING_RUNAWAY_RECOVERY_NUDGE,
    stuckToolRecoveryNudge: PR_1149_STUCK_TOOL_RECOVERY_NUDGE,
    exposesWriteFile: true,
    forcesRequestedOutputRecovery: true,
    warnsOnValidationEvidence: true,
    nonzeroShellResultIsError: false,
  },
  'app-absolute',
)

const PRODUCT_ALIGNED_V1 = legacyDefinition(
  {
    id: 'product-aligned',
    version: 1,
    versionedId: 'product-aligned@1',
    systemPrompt: PRODUCT_ALIGNED_V1_SYSTEM_PROMPT,
    reasoningRunawayRecoveryNudge: PRODUCT_ALIGNED_REASONING_RUNAWAY_RECOVERY_NUDGE,
    stuckToolRecoveryNudge: PRODUCT_ALIGNED_STUCK_TOOL_RECOVERY_NUDGE,
    exposesWriteFile: true,
    forcesRequestedOutputRecovery: false,
    warnsOnValidationEvidence: false,
    nonzeroShellResultIsError: true,
  },
  'app-absolute',
)

const PRODUCT_ALIGNED_V2_BASE = {
  id: 'product-aligned' as const,
  version: 2 as const,
  versionedId: 'product-aligned@2' as const,
  systemPrompt: PRODUCT_ALIGNED_SYSTEM_PROMPT,
  reasoningRunawayRecoveryNudge: PRODUCT_ALIGNED_REASONING_RUNAWAY_RECOVERY_NUDGE,
  stuckToolRecoveryNudge: PRODUCT_ALIGNED_STUCK_TOOL_RECOVERY_NUDGE,
  exposesWriteFile: true,
  writeFilePolicy: 'workspace-relative' as const,
  forcesRequestedOutputRecovery: false,
  warnsOnValidationEvidence: false,
  nonzeroShellResultIsError: true,
}

const PRODUCT_ALIGNED_V2: ProfileDefinition = {
  ...PRODUCT_ALIGNED_V2_BASE,
  reasoningPolicy: 'fixed-cap',
  loop: FIXED_CAP_LOOP,
  retirement: null,
  hashPayload: {
    hashSchema: 2,
    profile: PRODUCT_ALIGNED_V2_BASE,
    implementation: {
      bridgeProtocol: 'newline-delimited-json-v1',
      runShellTool: 'persistent-shell-with-bounded-timeout-v1',
      writeFileTool: 'workspace-relative-or-contained-absolute-path-base64-write-v1',
      shellResult: 'nonzero-exit-is-tool-error-v1',
      recovery: 'generic-agent-loop-nudges-no-forced-tool-v1',
    },
  },
}

const PRODUCT_ALIGNED_V3_BASE = {
  ...PRODUCT_ALIGNED_V2_BASE,
  version: 3 as const,
  versionedId: 'product-aligned@3' as const,
  reasoningPolicy: 'circle-gated-2k-checkpoints-v1' as const,
}

/**
 * v3's hash names its reasoning behaviour with a description instead of the
 * values the host used. Those values tracked live product constants, so v3
 * runs made as introduced in #1181, after #1204 moved the policy into the
 * product, after #1242 added the trailing budget and sentence/tail signals,
 * and after #1413 added text and cross-turn checks all share this hash while
 * behaving differently. It stays resolvable for those capsules but can no
 * longer be run; product-aligned@4 hashes the effective values instead.
 */
const PRODUCT_ALIGNED_V3: ProfileDefinition = {
  ...PRODUCT_ALIGNED_V3_BASE,
  loop: CHECKPOINTED_LOOP,
  retirement:
    'product-aligned@3 hashed a description of its reasoning policy rather than the values it ran with, so its hash covers behaviour that changed in #1204, #1242 and #1413. Run product-aligned@4 instead.',
  hashPayload: {
    hashSchema: 3,
    profile: PRODUCT_ALIGNED_V3_BASE,
    implementation: {
      bridgeProtocol: 'newline-delimited-json-v1',
      runShellTool: 'persistent-shell-with-bounded-timeout-v1',
      writeFileTool: 'workspace-relative-or-contained-absolute-path-base64-write-v1',
      shellResult: 'nonzero-exit-is-tool-error-v1',
      recovery: 'generic-agent-loop-nudges-no-forced-tool-v1',
      reasoning:
        '2k-checkpoints-high-confidence-self-report-repeat-structure-list100-max32k-recovery4k-v1',
    },
  },
}

const PRODUCT_ALIGNED_V4_BASE = {
  ...PRODUCT_ALIGNED_V2_BASE,
  version: 4 as const,
  versionedId: 'product-aligned@4' as const,
  reasoningPolicy: 'circle-gated-2k-checkpoints-v1' as const,
}

/**
 * v4 behaves exactly as v3 did immediately before it was retired. Its hash
 * covers the effective loop settings themselves, so any change to them needs a
 * new version rather than silently altering what this id means.
 */
const PRODUCT_ALIGNED_V4: ProfileDefinition = {
  ...PRODUCT_ALIGNED_V4_BASE,
  loop: CHECKPOINTED_LOOP,
  retirement: null,
  hashPayload: {
    hashSchema: 4,
    profile: PRODUCT_ALIGNED_V4_BASE,
    loop: CHECKPOINTED_LOOP,
    implementation: {
      bridgeProtocol: 'newline-delimited-json-v1',
      runShellTool: 'persistent-shell-with-bounded-timeout-v1',
      writeFileTool: 'workspace-relative-or-contained-absolute-path-base64-write-v1',
      shellResult: 'nonzero-exit-is-tool-error-v1',
    },
  },
}

const DEFINITIONS: Record<TerminalBenchProfileVersionedId, ProfileDefinition> = {
  'main-legacy@1': MAIN_LEGACY_V1,
  'main-legacy@2': MAIN_LEGACY_V2,
  'pr-1149@1': PR_1149_V1,
  'product-aligned@1': PRODUCT_ALIGNED_V1,
  'product-aligned@2': PRODUCT_ALIGNED_V2,
  'product-aligned@3': PRODUCT_ALIGNED_V3,
  'product-aligned@4': PRODUCT_ALIGNED_V4,
}

const CURRENT_PROFILE_VERSIONS: Record<TerminalBenchProfileId, TerminalBenchProfileVersionedId> = {
  'main-legacy': 'main-legacy@1',
  'pr-1149': 'pr-1149@1',
  'product-aligned': 'product-aligned@4',
}

/** JSON with object keys sorted, so a hash never depends on property order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  })
}

function profileHash(definition: ProfileDefinition): string {
  // v1–v3 hashes predate canonical ordering and stay byte-identical.
  const serialized =
    definition.version < 4
      ? JSON.stringify(definition.hashPayload)
      : canonicalJson(definition.hashPayload)
  return createHash('sha256').update(serialized).digest('hex')
}

export function parseTerminalBenchProfileId(value: string | undefined): TerminalBenchProfileId {
  const trimmed = value?.trim() ?? ''
  const candidate = trimmed === '' ? 'main-legacy' : trimmed
  for (const id of TERMINAL_BENCH_PROFILE_IDS) {
    if (id === candidate) return id
  }
  throw new Error(
    `Terminal-Bench profile must be one of ${TERMINAL_BENCH_PROFILE_IDS.join(', ')}, received '${candidate}'.`,
  )
}

export function parseTerminalBenchProfileIds(
  value: string | undefined,
): TerminalBenchProfileSelectionId[] {
  if (!value?.trim()) return ['main-legacy']
  const rawIds = value.split(',').map((item) => item.trim())
  if (rawIds.some((item) => !item)) {
    throw new Error('Terminal-Bench profiles must be a comma-separated list without empty items.')
  }
  const ids = rawIds.map((item) => parseTerminalBenchProfileSelectionId(item))
  const versions = ids.map((id) => terminalBenchProfile(id).versionedId)
  if (new Set(versions).size !== versions.length) {
    throw new Error('Terminal-Bench profiles must not contain duplicates.')
  }
  return ids
}

export function parseTerminalBenchProfileSelectionId(
  value: string | undefined,
): TerminalBenchProfileSelectionId {
  const trimmed = value?.trim() ?? ''
  const candidate = trimmed === '' ? 'main-legacy' : trimmed
  if (isVersionedProfileId(candidate)) return candidate
  return parseTerminalBenchProfileId(candidate)
}

export function rotateTerminalBenchProfiles(
  profiles: readonly TerminalBenchProfileSelectionId[],
  offset: number,
): TerminalBenchProfileSelectionId[] {
  if (profiles.length === 0) throw new Error('at least one Terminal-Bench profile is required')
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(
      `profile rotation offset must be a non-negative integer, received '${String(offset)}'`,
    )
  }
  const normalized = offset % profiles.length
  return [...profiles.slice(normalized), ...profiles.slice(0, normalized)]
}

const isVersionedProfileId = keyOf(DEFINITIONS)

export function terminalBenchProfile(
  value: string | undefined = process.env['COPSE_TERMINAL_PROFILE'],
): TerminalBenchProfile {
  const trimmed = value?.trim() ?? ''
  const candidate = trimmed === '' ? 'main-legacy' : trimmed
  const versionedId = isVersionedProfileId(candidate)
    ? candidate
    : CURRENT_PROFILE_VERSIONS[parseTerminalBenchProfileId(candidate)]
  const { hashPayload: _, ...definition } = DEFINITIONS[versionedId]
  return {
    ...definition,
    preflightProbe: definition.preflightProbe ?? false,
    contentHash: profileHash(DEFINITIONS[versionedId]),
  }
}

/**
 * Resolve a profile for a new run. Retired profiles resolve for historical
 * capsules through {@link terminalBenchProfile} but must never start one.
 */
export function runnableTerminalBenchProfile(value: string | undefined): TerminalBenchProfile {
  const profile = terminalBenchProfile(value)
  if (profile.retirement !== null) throw new Error(profile.retirement)
  return profile
}

/** {@link parseTerminalBenchProfileIds} for a new run: retired profiles are rejected. */
export function parseRunnableTerminalBenchProfileIds(
  value: string | undefined,
): TerminalBenchProfileSelectionId[] {
  const ids = parseTerminalBenchProfileIds(value)
  for (const id of ids) runnableTerminalBenchProfile(id)
  return ids
}

/**
 * Stream caps a run used that differ from the ones its profile declares. Empty
 * means the run behaved as the profile's hash describes.
 */
export function terminalBenchStreamCapOverrides(
  profile: TerminalBenchProfile,
  runtime: Pick<
    TerminalBenchRuntimeConfiguration,
    'maxStreamOutputTokens' | 'reasoningRunawayRecoveryOutputTokens'
  >,
): TerminalBenchStreamCapOverrides {
  return {
    ...(runtime.maxStreamOutputTokens === profile.loop.maxStreamOutputTokens
      ? {}
      : { maxStreamOutputTokens: runtime.maxStreamOutputTokens }),
    ...(runtime.reasoningRunawayRecoveryOutputTokens ===
    profile.loop.reasoningRunawayRecoveryOutputTokens
      ? {}
      : { reasoningRunawayRecoveryOutputTokens: runtime.reasoningRunawayRecoveryOutputTokens }),
  }
}
