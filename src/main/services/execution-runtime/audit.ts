/**
 * Always-on execution audit (`docs/plans/execution-runtime-security.md`, R1 and
 * binding decision 6).
 *
 * {@link withExecutionAudit} wraps a runtime so every execution started inside
 * an agent turn emits one start and one exit observation, each naming the
 * runtime profile it ran under and the principal it acted for. The sink that
 * turns observations into thread-spine lines is registered at startup, which
 * keeps the decision-log writer's import graph out of low-level spawn code.
 */
import { randomUUID } from 'node:crypto'
import type {
  ExecutionPrincipal,
  ExecutionRuntimeCapabilities,
  RuntimeProfile,
} from '@shared/threads/execution-runtime.ts'
import { currentThreadExecutionContext } from '../thread-execution-context-store.ts'
import { resolveExecutionPrincipal } from './principal.ts'
import type {
  ExecutionRuntime,
  RuntimeCommand,
  RuntimeExecRequest,
  RuntimeExecution,
} from './runtime.ts'

export interface ExecutionOwner {
  readonly projectId: string
  readonly threadId: string
}

interface ObservationBase {
  readonly owner: ExecutionOwner
  readonly principal: ExecutionPrincipal
  readonly processRunId: string
  readonly profile: RuntimeProfile
}

export type ExecutionObservation =
  | (ObservationBase & {
      readonly type: 'start'
      readonly command: RuntimeCommand
      readonly capabilities: ExecutionRuntimeCapabilities
    })
  | (ObservationBase & {
      readonly type: 'exit'
      readonly exitCode: number | null
      readonly signal: string | null
      /** The process never started (`spawn` emitted `error` without `exit`). */
      readonly spawnError?: true
    })

export type ExecutionAuditSink = (observation: ExecutionObservation) => void

let registeredSink: ExecutionAuditSink | null = null

/** Register where observations go; until then they are dropped. */
export function setExecutionAuditSink(sink: ExecutionAuditSink | null): void {
  registeredSink = sink
}

function emit(sink: ExecutionAuditSink, observation: ExecutionObservation): void {
  try {
    sink(observation)
  } catch {
    // Auditing never fails the execution it describes.
  }
}

/**
 * Wrap a runtime so in-turn executions are observed. Executions outside an
 * agent turn (Copse's own background probes, renderer IPCs) have no thread to
 * attribute them to and are not recorded.
 */
export function withExecutionAudit(
  runtime: ExecutionRuntime,
  sink: () => ExecutionAuditSink | null = () => registeredSink,
): ExecutionRuntime {
  return {
    kind: runtime.kind,
    capabilities: (request) => runtime.capabilities(request),
    stop: () => runtime.stop(),
    exec: async (request: RuntimeExecRequest): Promise<RuntimeExecution> => {
      // Read before the first await: the turn's context is what authorized it.
      const context = currentThreadExecutionContext()
      const execution = await runtime.exec(request)
      const target = sink()
      if (!context || !target) return execution

      const owner = { projectId: context.projectId, threadId: context.threadId }
      const base: ObservationBase = {
        owner,
        principal: resolveExecutionPrincipal(context),
        processRunId: randomUUID(),
        profile: execution.profile,
      }
      emit(target, {
        ...base,
        type: 'start',
        command: request.command,
        capabilities: execution.capabilities,
      })
      let settled = false
      execution.child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        emit(target, { ...base, type: 'exit', exitCode: code, signal })
      })
      execution.child.once('error', () => {
        // An `error` without `exit` means the process never ran; a later
        // `exit` (a kill that failed after start) still records normally.
        setImmediate(() => {
          if (settled || execution.child.exitCode !== null || execution.child.pid !== undefined) {
            return
          }
          settled = true
          emit(target, { ...base, type: 'exit', exitCode: null, signal: null, spawnError: true })
        })
      })
      return execution
    },
  }
}
