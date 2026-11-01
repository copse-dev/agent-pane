// Where a `run_shell` / `run_background` command is between submission and exit
// (#3956). Before this, a card read "Running command" from the moment the model
// asked for it, so a command waiting on approval, one whose sandbox never
// launched, and one actually running all looked the same.
//
// The agent service scopes a reporter around each command tool call; the gate,
// the approval broker, and the spawn path report into whichever reporter is in
// scope. Outside a scope (subagents, ACP-bridged shells, tests) every report is
// a no-op, so callers never need to know whether anyone is listening.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { CommandPhase, CommandPhaseState } from '@copse/agent/wire-types.ts'
import type { ToolCallChunk } from '@shared/types/stream.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

/** Delivers one call's new stage to the transcript. */
export type CommandPhaseSink = (phase: CommandPhase) => void

interface CommandPhaseReporter {
  readonly sink: CommandPhaseSink
  current: CommandPhase
}

const reporters = new AsyncLocalStorage<CommandPhaseReporter>()

/** Stages after which nothing further runs for this attempt. */
const TERMINAL_STATES: ReadonlySet<CommandPhaseState> = new Set([
  'exited',
  'timed_out',
  'cancelled',
  'not_started',
])

export function isTerminalCommandPhase(state: CommandPhaseState): boolean {
  return TERMINAL_STATES.has(state)
}

/** Longest `reason` kept, so a refusal's full text never lands on the spine. */
const REASON_MAX_CHARS = 200

function shortReason(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line.length > REASON_MAX_CHARS ? `${line.slice(0, REASON_MAX_CHARS - 1)}…` : line
}

/** Whether this call is a command the loop runs itself, and so gets phases. */
export function isPhasedCommandCall(name: string, args: unknown): boolean {
  if (name === 'run_shell') return true
  return name === 'run_background' && isRecord(args) && args['action'] === 'start'
}

/** The `queued` stage for a just-announced command call, or null for any other tool. */
export function queuedCommandPhase(
  toolCall: Pick<ToolCallChunk, 'name' | 'args'>,
  now = Date.now(),
): CommandPhase | null {
  if (!isPhasedCommandCall(toolCall.name, toolCall.args)) return null
  return { state: 'queued', since: now, launched: false }
}

export interface CommandPhaseDetail {
  exitCode?: number
  backgroundTaskId?: string
  reason?: string
}

function emit(reporter: CommandPhaseReporter, phase: CommandPhase): void {
  reporter.current = phase
  reporter.sink(phase)
}

function nextPhase(
  reporter: CommandPhaseReporter,
  state: CommandPhaseState,
  detail: CommandPhaseDetail,
): CommandPhase {
  return {
    state,
    since: Date.now(),
    // Sticky: a command that ran once and is now awaiting a retry's approval
    // still ran. Only the spawn path sets it, by reporting `running`.
    launched: reporter.current.launched || state === 'running',
    ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
    ...(detail.backgroundTaskId !== undefined ? { backgroundTaskId: detail.backgroundTaskId } : {}),
    ...(detail.reason !== undefined ? { reason: shortReason(detail.reason) } : {}),
  }
}

/**
 * Run one command tool call with a reporter in scope. `initial` is the stage
 * already shown (normally `queued`). When `fn` settles without reaching a
 * terminal stage, the call is closed as `not_started` — unless it is running
 * on as a background task, which outlives the call by design.
 */
export async function runWithCommandPhaseReporter<T>(
  sink: CommandPhaseSink,
  initial: CommandPhase,
  fn: () => Promise<T>,
  describeOutcome: (outcome: { value: T } | { error: unknown }) => string,
): Promise<T> {
  const reporter: CommandPhaseReporter = { sink, current: initial }
  const settle = (outcome: { value: T } | { error: unknown }): void => {
    const { state, backgroundTaskId } = reporter.current
    if (isTerminalCommandPhase(state)) return
    if (state === 'running' && backgroundTaskId !== undefined) return
    if (state === 'running') {
      // The spawn path reports every way a launched process ends; reaching
      // here means it was abandoned mid-run (e.g. the runner itself threw).
      emit(reporter, nextPhase(reporter, 'cancelled', {}))
      return
    }
    emit(reporter, nextPhase(reporter, 'not_started', { reason: describeOutcome(outcome) }))
  }
  return reporters.run(reporter, async () => {
    try {
      const value = await fn()
      settle({ value })
      return value
    } catch (error) {
      settle({ error })
      throw error
    }
  })
}

export type CommandPhaseReport = (state: CommandPhaseState, detail?: CommandPhaseDetail) => void

/**
 * The in-scope command's reporter, bound now. Child-process event callbacks
 * are not guaranteed to run inside the scope that spawned the process, so the
 * spawn path captures this once and reports through it. A no-op outside a scope.
 */
export function captureCommandPhaseReport(): CommandPhaseReport {
  const reporter = reporters.getStore()
  return (state, detail = {}) => {
    if (reporter) emit(reporter, nextPhase(reporter, state, detail))
  }
}

/** Report the in-scope command's new stage. A no-op outside a reporter scope. */
export function reportCommandPhase(
  state: CommandPhaseState,
  detail: CommandPhaseDetail = {},
): void {
  captureCommandPhaseReport()(state, detail)
}

/**
 * Mark the in-scope command as waiting on the user. Returns the callback to
 * run once the prompt is answered, or null outside a reporter scope.
 *
 * An approval before launch (the gate, an up-front escalation) moves on to
 * `starting`. Any other answer puts back the stage the prompt interrupted: a
 * declined gate then settles as `not_started` with the tool's own refusal, a
 * declined escalation still runs contained and reports its own stages, and a
 * declined retry offer leaves the first run's exit as the last thing that
 * happened.
 */
export function beginCommandApprovalWait(): ((approved: boolean) => void) | null {
  const reporter = reporters.getStore()
  if (!reporter) return null
  const before = reporter.current
  if (before.state === 'awaiting_approval') return () => undefined
  emit(reporter, nextPhase(reporter, 'awaiting_approval', {}))
  return (approved) => {
    // Something else has already moved the command on (the call was torn down).
    if (reporter.current.state !== 'awaiting_approval') return
    const beforeLaunch = before.state === 'queued' || before.state === 'starting'
    emit(reporter, approved && beforeLaunch ? nextPhase(reporter, 'starting', {}) : before)
  }
}
