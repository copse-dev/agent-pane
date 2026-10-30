/**
 * Turns execution observations into thread-spine decision lines
 * (`docs/decision-log-format.md`, execution audit). Registered at startup with
 * {@link setExecutionAuditSink}; headless hosts route the same lines through
 * their scoped decision recorder.
 */
import { basename } from 'node:path'
import {
  runtimeProfileId,
  type ExecutionRuntimeCapabilities,
} from '@shared/threads/execution-runtime.ts'
import { SHELL_DECISION_SUBJECT } from '@shared/threads/decision-log.ts'
import { recordDecision, type RecordDecisionInput } from '../security/decision-log-store.ts'
import type { ExecutionObservation } from './audit.ts'
import type { RuntimeCommand } from './runtime.ts'

/**
 * Runtime profiles already announced per thread, keyed with their capability
 * snapshot so a changed snapshot (a new property, a brokered credential) is
 * recorded again. In memory: a restart re-announces once, which is the point —
 * the record says what the runtime was during this session.
 */
const announced = new Set<string>()

function processSubject(command: RuntimeCommand): string {
  if (command.kind === 'shell') return SHELL_DECISION_SUBJECT
  return `${basename(command.executable)} (arguments omitted)`
}

function announceRuntime(
  observation: Extract<ExecutionObservation, { type: 'start' }>,
  runtime: string,
  capabilities: ExecutionRuntimeCapabilities,
): void {
  const key = [
    observation.owner.projectId,
    observation.owner.threadId,
    runtime,
    JSON.stringify(capabilities),
  ].join('\0')
  if (announced.has(key)) return
  announced.add(key)
  recordDecision({
    projectId: observation.owner.projectId,
    threadId: observation.owner.threadId,
    kind: 'runtime-state',
    actor: 'system',
    verdict: 'observed',
    subject: runtime,
    runtime,
    capabilities,
    principalId: observation.principal.id,
    principalKind: observation.principal.kind,
  })
}

export function recordExecutionObservation(observation: ExecutionObservation): void {
  const runtime = runtimeProfileId(observation.profile)
  const common = {
    projectId: observation.owner.projectId,
    threadId: observation.owner.threadId,
    actor: 'system',
    verdict: 'observed',
    runtime,
    processRunId: observation.processRunId,
    principalId: observation.principal.id,
    principalKind: observation.principal.kind,
  } satisfies Partial<RecordDecisionInput>
  if (observation.type === 'start') {
    announceRuntime(observation, runtime, observation.capabilities)
    recordDecision({
      ...common,
      kind: 'process-run',
      subject: processSubject(observation.command),
      scope:
        observation.profile.kind === 'local' && observation.profile.containment === 'contained'
          ? 'sandbox'
          : 'external',
    })
    return
  }
  recordDecision({
    ...common,
    kind: 'process-exit',
    subject: observation.spawnError ? 'process did not start' : 'process exited',
    ...(observation.exitCode !== null ? { exitCode: observation.exitCode } : {}),
    ...(observation.signal !== null ? { exitSignal: observation.signal } : {}),
  })
}
