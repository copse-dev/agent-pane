import { createHash } from 'node:crypto'

export const TERMINAL_BENCH_PROFILE_IDS = ['main-legacy', 'pr-1149', 'product-aligned'] as const

export type TerminalBenchProfileId = (typeof TERMINAL_BENCH_PROFILE_IDS)[number]

export interface TerminalBenchProfile {
  id: TerminalBenchProfileId
  version: 1
  versionedId: `${TerminalBenchProfileId}@1`
  contentHash: string
  systemPrompt: string
  reasoningRunawayRecoveryNudge: string
  stuckToolRecoveryNudge: string
  exposesWriteFile: boolean
  forcesRequestedOutputRecovery: boolean
  warnsOnValidationEvidence: boolean
  nonzeroShellResultIsError: boolean
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

export const PRODUCT_ALIGNED_SYSTEM_PROMPT = `You are an autonomous coding agent in a persistent task environment.
Use run_shell to inspect and validate the workspace, and write_file to create or replace text files under /app. Make concrete edits after brief inspection, run focused validation, and continue until the requested outcome is complete or practical approaches are exhausted. Commands that fail are reported as tool errors; diagnose them rather than treating their output as success. There is no user available for follow-up questions.`

type ProfileDefinition = Omit<TerminalBenchProfile, 'contentHash'>

const DEFINITIONS: Record<TerminalBenchProfileId, ProfileDefinition> = {
  'main-legacy': {
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
  'pr-1149': {
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
  'product-aligned': {
    id: 'product-aligned',
    version: 1,
    versionedId: 'product-aligned@1',
    systemPrompt: PRODUCT_ALIGNED_SYSTEM_PROMPT,
    reasoningRunawayRecoveryNudge: PRODUCT_ALIGNED_REASONING_RUNAWAY_RECOVERY_NUDGE,
    stuckToolRecoveryNudge: PRODUCT_ALIGNED_STUCK_TOOL_RECOVERY_NUDGE,
    exposesWriteFile: true,
    forcesRequestedOutputRecovery: false,
    warnsOnValidationEvidence: false,
    nonzeroShellResultIsError: true,
  },
}

function profileHash(definition: ProfileDefinition): string {
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex')
}

export function parseTerminalBenchProfileId(value: string | undefined): TerminalBenchProfileId {
  const candidate = value?.trim() || 'main-legacy'
  for (const id of TERMINAL_BENCH_PROFILE_IDS) {
    if (id === candidate) return id
  }
  throw new Error(
    `Terminal-Bench profile must be one of ${TERMINAL_BENCH_PROFILE_IDS.join(', ')}, received '${candidate}'.`,
  )
}

export function parseTerminalBenchProfileIds(value: string | undefined): TerminalBenchProfileId[] {
  if (!value?.trim()) return ['main-legacy']
  const rawIds = value.split(',').map((item) => item.trim())
  if (rawIds.some((item) => !item)) {
    throw new Error('Terminal-Bench profiles must be a comma-separated list without empty items.')
  }
  const ids = rawIds.map((item) => parseTerminalBenchProfileId(item))
  if (new Set(ids).size !== ids.length) {
    throw new Error('Terminal-Bench profiles must not contain duplicates.')
  }
  return ids
}

export function rotateTerminalBenchProfiles(
  profiles: readonly TerminalBenchProfileId[],
  offset: number,
): TerminalBenchProfileId[] {
  if (profiles.length === 0) throw new Error('at least one Terminal-Bench profile is required')
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(
      `profile rotation offset must be a non-negative integer, received '${String(offset)}'`,
    )
  }
  const normalized = offset % profiles.length
  return [...profiles.slice(normalized), ...profiles.slice(0, normalized)]
}

export function terminalBenchProfile(
  value: string | undefined = process.env['COPSE_TERMINAL_PROFILE'],
): TerminalBenchProfile {
  const definition = DEFINITIONS[parseTerminalBenchProfileId(value)]
  return { ...definition, contentHash: profileHash(definition) }
}
