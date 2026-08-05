import type { AgentHost } from '@copse/agent/agent-host.ts'
import { canContinue } from '@copse/agent/hooks/continuation-budget.ts'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import {
  SPINE_SCHEMA_VERSION,
  type MachineContinuationResult,
  type SpineMachineContinuationLine,
} from '@shared/threads/spine-schema.ts'
import { randomUUID } from 'node:crypto'
import type { TodoItem } from '@shared/types/todo.ts'
import { runAgent, type RunAgentOptions } from './agent-service.ts'
import {
  prepareThreadExecutionContext,
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from './thread-execution-context.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import {
  appendMachineContinuation,
  loadAgentHistory,
  loadAgentTurnEpoch,
  saveAgentHistory,
  saveAgentTurnEpoch,
  type AgentTurnEpoch,
} from './thread-store.ts'
import type { ToolRegistry } from './tool-registry.ts'

export interface AgentDispatchPayload {
  userContent: UserContent
  invokedSkills: string[]
  priorTodos: TodoItem[]
  workingBrief?: string
  model?: string
  turnTreeId?: string
  continuationBudgetUsed?: number
}

export interface AgentDispatchRequest {
  projectId: string
  threadId: string
  payload: AgentDispatchPayload
}

export interface MachineAgentDispatchRequest extends AgentDispatchRequest {
  operationId: string
  turnTreeId: string
}

export type MachineDispatchResult = 'completed' | 'duplicate' | 'stale' | 'budget-exhausted'

export interface AgentDispatcherDependencies {
  loadHistory: (projectId: string, threadId: string) => Promise<LLMMessage[]>
  saveHistory: (projectId: string, threadId: string, messages: LLMMessage[]) => Promise<void>
  loadEpoch: (projectId: string, threadId: string) => Promise<AgentTurnEpoch | null>
  saveEpoch: (projectId: string, threadId: string, epoch: AgentTurnEpoch) => Promise<void>
  appendMachineContinuation: (
    projectId: string,
    threadId: string,
    line: SpineMachineContinuationLine,
  ) => Promise<void>
  now: () => number
  createId: () => string
  prepareExecutionContext: (
    projectId: string,
    threadId: string,
    host: AgentHost<StreamChunk>,
  ) => Promise<ThreadExecutionContext | null>
  run: (
    threadId: string,
    userContent: UserContent,
    priorMessages: LLMMessage[],
    host: AgentHost<StreamChunk>,
    registry: ToolRegistry,
    options: RunAgentOptions,
  ) => ReturnType<typeof runAgent>
}

const defaultDependencies: AgentDispatcherDependencies = {
  loadHistory: loadAgentHistory,
  saveHistory: saveAgentHistory,
  loadEpoch: loadAgentTurnEpoch,
  saveEpoch: saveAgentTurnEpoch,
  appendMachineContinuation,
  now: Date.now,
  createId: randomUUID,
  prepareExecutionContext: prepareThreadExecutionContext,
  run: runAgent,
}

function dispatchKey(projectId: string, threadId: string): string {
  return `${projectId}\0${threadId}`
}

/** Main-process authority for starting primary agent turns and committing provider history. */
export class AgentDispatcher {
  private readonly histories = new Map<string, LLMMessage[]>()
  private readonly active = new Map<string, Promise<void>>()
  private readonly epochs = new Map<string, { turnTreeId: string; continuationUsed: number }>()
  private readonly epochWrites = new Map<string, Promise<void>>()
  private readonly machineOperations = new Map<string, Promise<MachineDispatchResult>>()
  private readonly host: AgentHost<StreamChunk>
  private readonly registry: ToolRegistry
  private readonly dependencies: AgentDispatcherDependencies

  constructor(
    host: AgentHost<StreamChunk>,
    registry: ToolRegistry,
    dependencies: AgentDispatcherDependencies = defaultDependencies,
  ) {
    this.host = host
    this.registry = registry
    this.dependencies = dependencies
  }

  async dispatch(request: AgentDispatchRequest): Promise<void> {
    const key = dispatchKey(request.projectId, request.threadId)
    const epochWrite = this.observeRendererEpoch(key, request)
    this.epochWrites.set(key, epochWrite)
    try {
      await epochWrite
    } finally {
      if (this.epochWrites.get(key) === epochWrite) this.epochWrites.delete(key)
    }
    await this.dispatchInternal(request)
  }

  dispatchMachine(request: MachineAgentDispatchRequest): Promise<MachineDispatchResult> {
    const operationKey = `${dispatchKey(request.projectId, request.threadId)}\0${request.operationId}`
    const existing = this.machineOperations.get(operationKey)
    if (existing) {
      return existing.then(async (): Promise<MachineDispatchResult> => {
        await this.recordMachineFinish(request, 'duplicate')
        return 'duplicate'
      })
    }

    const running = this.executeMachine(request)
    this.machineOperations.set(operationKey, running)
    // Keep dedupe records bounded. Deleting the oldest completed operation does
    // not widen authority: a replay still has to pass epoch and budget checks.
    if (this.machineOperations.size > 1_000) {
      const oldest = this.machineOperations.keys().next().value
      if (oldest !== undefined && oldest !== operationKey) this.machineOperations.delete(oldest)
    }
    return running
  }

  isActive(projectId: string, threadId: string): boolean {
    return this.active.has(dispatchKey(projectId, threadId))
  }

  async history(projectId: string, threadId: string): Promise<LLMMessage[]> {
    const key = dispatchKey(projectId, threadId)
    let messages = this.histories.get(key)
    if (!messages) {
      messages = await this.dependencies.loadHistory(projectId, threadId)
      this.histories.set(key, messages)
    }
    return messages
  }

  forgetHistory(projectId: string, threadId: string): void {
    const key = dispatchKey(projectId, threadId)
    this.histories.delete(key)
    this.epochs.delete(key)
  }

  private async observeRendererEpoch(key: string, request: AgentDispatchRequest): Promise<void> {
    const { payload } = request
    if (payload.turnTreeId === undefined) return
    const used = Math.max(0, payload.continuationBudgetUsed ?? 0)
    const current = this.epochs.get(key)
    const next = {
      turnTreeId: payload.turnTreeId,
      continuationUsed:
        current?.turnTreeId === payload.turnTreeId
          ? Math.max(current.continuationUsed, used)
          : used,
    }
    await this.dependencies.saveEpoch(request.projectId, request.threadId, next)
    this.epochs.set(key, next)
  }

  private async executeMachine(
    request: MachineAgentDispatchRequest,
  ): Promise<MachineDispatchResult> {
    const key = dispatchKey(request.projectId, request.threadId)
    await this.epochWrites.get(key)
    for (;;) {
      const active = this.active.get(key)
      if (!active) break
      try {
        await active
      } catch {
        // A failed foreground turn still releases the per-thread dispatch slot.
      }
    }

    let epoch = this.epochs.get(key)
    if (!epoch) {
      const persisted = await this.dependencies.loadEpoch(request.projectId, request.threadId)
      if (persisted) {
        epoch = persisted
        this.epochs.set(key, persisted)
      }
    }
    if (epoch?.turnTreeId !== request.turnTreeId) {
      await this.recordMachineFinish(request, 'stale', epoch?.continuationUsed)
      return 'stale'
    }
    if (!canContinue(epoch.continuationUsed)) {
      await this.recordMachineFinish(request, 'budget-exhausted', epoch.continuationUsed)
      return 'budget-exhausted'
    }

    const nextEpoch = { ...epoch, continuationUsed: epoch.continuationUsed + 1 }
    await this.recordMachineStart(request, nextEpoch.continuationUsed)
    try {
      await this.dependencies.saveEpoch(request.projectId, request.threadId, nextEpoch)
      this.epochs.set(key, nextEpoch)
      await this.dispatchInternal({
        ...request,
        payload: {
          ...request.payload,
          turnTreeId: request.turnTreeId,
          continuationBudgetUsed: nextEpoch.continuationUsed,
        },
      })
    } catch (error) {
      await this.recordMachineFinish(request, 'failed', nextEpoch.continuationUsed)
      throw error
    }
    await this.recordMachineFinish(request, 'completed', nextEpoch.continuationUsed)
    return 'completed'
  }

  private recordMachineStart(
    request: MachineAgentDispatchRequest,
    budgetUsed: number,
  ): Promise<void> {
    return this.dependencies.appendMachineContinuation(request.projectId, request.threadId, {
      v: SPINE_SCHEMA_VERSION,
      type: 'machine_continuation',
      id: this.dependencies.createId(),
      operationId: request.operationId,
      turnTreeId: request.turnTreeId,
      recordedAt: this.dependencies.now(),
      budgetUsed,
      phase: 'started',
    })
  }

  private recordMachineFinish(
    request: MachineAgentDispatchRequest,
    result: MachineContinuationResult,
    budgetUsed?: number,
  ): Promise<void> {
    return this.dependencies.appendMachineContinuation(request.projectId, request.threadId, {
      v: SPINE_SCHEMA_VERSION,
      type: 'machine_continuation',
      id: this.dependencies.createId(),
      operationId: request.operationId,
      turnTreeId: request.turnTreeId,
      recordedAt: this.dependencies.now(),
      ...(budgetUsed !== undefined ? { budgetUsed } : {}),
      phase: 'finished',
      result,
    })
  }

  private async dispatchInternal(request: AgentDispatchRequest): Promise<void> {
    const key = dispatchKey(request.projectId, request.threadId)
    const existing = this.active.get(key)
    if (existing) {
      throw new Error(`An agent turn is already running for thread "${request.threadId}"`)
    }

    const running = this.execute(request, key)
    this.active.set(key, running)
    try {
      await running
    } finally {
      if (this.active.get(key) === running) this.active.delete(key)
    }
  }

  private async execute(request: AgentDispatchRequest, key: string): Promise<void> {
    const { projectId, threadId, payload } = request
    const priorMessages = await this.history(projectId, threadId)
    const executionContext = await this.dependencies.prepareExecutionContext(
      projectId,
      threadId,
      this.host,
    )
    if (!executionContext) return

    const options: RunAgentOptions = {
      invokedSkills: payload.invokedSkills,
      priorTodos: payload.priorTodos,
      ...(payload.workingBrief !== undefined ? { workingBrief: payload.workingBrief } : {}),
      ...(payload.model !== undefined ? { model: payload.model } : {}),
      ...(payload.turnTreeId !== undefined ? { turnTreeId: payload.turnTreeId } : {}),
      ...(payload.continuationBudgetUsed !== undefined
        ? { continuationBudgetUsed: payload.continuationBudgetUsed }
        : {}),
    }
    const result = await runWithThreadExecutionContext(executionContext, () =>
      runWithActiveRunIdentity(threadId, () =>
        this.dependencies.run(
          threadId,
          payload.userContent,
          priorMessages,
          this.host,
          this.registry,
          options,
        ),
      ),
    )
    this.histories.set(key, result.messages)
    await this.dependencies.saveHistory(projectId, threadId, result.messages)
  }
}
