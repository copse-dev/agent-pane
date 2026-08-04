import type { AgentHost } from '@copse/agent/agent-host.ts'
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
    this.histories.delete(dispatchKey(projectId, threadId))
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
