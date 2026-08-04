import type { AgentHost } from '@copse/agent/agent-host.ts'
import { canContinue } from '@copse/agent/hooks/continuation-budget.ts'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import { runAgent, type RunAgentOptions } from './agent-service.ts'
import {
  prepareThreadExecutionContext,
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from './thread-execution-context.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import { loadAgentHistory, saveAgentHistory } from './thread-store.ts'
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
    this.observeRendererEpoch(key, request.payload)
    await this.dispatchInternal(request)
  }

  dispatchMachine(request: MachineAgentDispatchRequest): Promise<MachineDispatchResult> {
    const operationKey = `${dispatchKey(request.projectId, request.threadId)}\0${request.operationId}`
    const existing = this.machineOperations.get(operationKey)
    if (existing) return existing.then(() => 'duplicate')

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

  private observeRendererEpoch(key: string, payload: AgentDispatchPayload): void {
    if (payload.turnTreeId === undefined) return
    const used = Math.max(0, payload.continuationBudgetUsed ?? 0)
    const current = this.epochs.get(key)
    this.epochs.set(key, {
      turnTreeId: payload.turnTreeId,
      continuationUsed:
        current?.turnTreeId === payload.turnTreeId
          ? Math.max(current.continuationUsed, used)
          : used,
    })
  }

  private async executeMachine(
    request: MachineAgentDispatchRequest,
  ): Promise<MachineDispatchResult> {
    const key = dispatchKey(request.projectId, request.threadId)
    const active = this.active.get(key)
    if (active) {
      try {
        await active
      } catch {
        // A failed foreground turn still releases the per-thread dispatch slot.
      }
    }

    const epoch = this.epochs.get(key)
    if (epoch?.turnTreeId !== request.turnTreeId) return 'stale'
    if (!canContinue(epoch.continuationUsed)) return 'budget-exhausted'

    epoch.continuationUsed += 1
    await this.dispatchInternal({
      ...request,
      payload: {
        ...request.payload,
        turnTreeId: request.turnTreeId,
        continuationBudgetUsed: epoch.continuationUsed,
      },
    })
    return 'completed'
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
