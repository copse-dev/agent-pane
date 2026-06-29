import { runAgentLoop } from '@shared/agent/run-agent-loop.ts'
import type { AgentHost } from '@shared/agent/agent-host.ts'
import {
  createAgentRunAbortScheduler,
  DEFAULT_MAX_LLM_CALLS,
} from '@shared/agent/agent-loop-limits.ts'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { getSetting } from './settings.ts'
import { resolveContextWindow } from './resolve-context-window.ts'
import { classifyAgentError } from './agent-errors.ts'
import { resolveParentGoal } from '@shared/agent/working-brief.ts'
import { buildSystemPrompt } from './agent-system-prompt.ts'
import { hasLastUsage } from './provider-usage.ts'
import { clearActiveRunThread, recordThreadModel, setActiveRunThread } from './thread-models.ts'
import { createAgentChunkSink } from './agent-chunk-sink.ts'
import { buildCommitSteeringPrompt, shouldSteerCommit } from '@shared/git/commit-attribution.ts'
import {
  buildProvider,
  buildSubagentRoute,
  buildReviewRoute,
  isLocalChatModel,
} from './provider-selection.ts'
import { runPostTurnReview } from './review-subagent-runner.ts'
import { isEditTool } from '@shared/agent/review-subagent.ts'
import {
  prepareAgentHistory,
  contextTrimmedChunk,
  contextPressureChunk,
  createTrimNotifier,
  promptExceedsContextWindow,
  oversizedTurnMessage,
} from './history-trimming.ts'
import {
  runWithAgentRunReadFileLimits,
  getAgentRunReadFileLimits,
  readFileLimitsFromConversationBudget,
} from './agent-run-read-limits.ts'
import { runWithAgentRunReadonly } from './agent-run-readonly.ts'
import { isToolAllowedInReadonlyMode } from '@shared/tools/readonly-tools.ts'
import { getMcpToolMeta } from './mcp-registry.ts'
import { formatReadFileLimitHint } from '@shared/agent/read-file-limits.ts'
import { setExploreSubagentContext } from './explore-subagent-runner.ts'
import { setCiInvestigatorContext } from './ci-investigator-runner.ts'
import { resetSubagentUsage, getAccumulatedSubagentUsage } from './subagent-usage.ts'
import { setAgentRunTodoContext, clearAgentRunTodos, getAgentRunTodos } from './agent-run-todos.ts'
import {
  buildGithubLinkSteeringPrompt,
  shouldSteerGithubLinks,
} from '@shared/git/github-link-steering.ts'
import { getGithubRepoSlug } from './git-service.ts'
import {
  shouldSteerTodos,
  formatTodosForPrompt,
  findNewlyInProgressLocal,
  findNewlyCompleted,
  shouldRouteToLocal,
  TODO_STEERING_PROMPT,
} from '@shared/todos/todo-logic.ts'
import { compactAtTodoBoundary } from '@shared/todos/todo-context.ts'
import { setTodoToolPostProcess } from '../tools/todo-tool.ts'
import { runTodoWorker } from './todo-worker-runner.ts'
import { verifyTodoCheck } from './todo-verification.ts'
import type { TodoItem } from '@shared/types/todo.ts'
import { parseRemoteAgentModel } from '@shared/remote-agent.ts'
import { runRemoteAgentFromSettings } from './remote-agent-client.ts'

// Re-export the public surface so existing IPC/test imports stay stable while the
// implementation lives in focused modules.
export {
  isLocalChatModel,
  buildSubagentRoute,
  listLmStudioModels,
  invalidateLmStudioModelsCache,
  testLmStudio,
} from './provider-selection.ts'
export {
  suggestThreadTitle,
  suggestTerminalTitle,
  suggestCommandSummary,
} from './title-generator.ts'

const abortMap = new Map<string, AbortController>()

export const PARENT_DELEGATED_TOOLS = [
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'find_files',
] as const

/** Tools that only function as subagent entry points; hidden when subagents are off. */
const SUBAGENT_ENTRY_TOOLS = new Set<string>(['explore', 'investigate_ci'])

function parentTools(registry: ToolRegistry, subagentsEnabled: boolean, readonlyMode: boolean) {
  let tools = registry.toLLMTools()
  if (!subagentsEnabled) {
    tools = tools
      .filter((t) => !SUBAGENT_ENTRY_TOOLS.has(t.name))
      .map((t) =>
        t.name === 'read_file'
          ? {
              ...t,
              description: `Read a file from the workspace. ${formatReadFileLimitHint(
                getAgentRunReadFileLimits(),
              )}; use start_line / end_line for more.`,
            }
          : t,
      )
  } else {
    const excluded = new Set<string>(PARENT_DELEGATED_TOOLS)
    tools = tools.filter((t) => !excluded.has(t.name))
  }
  // Keep the offered tool set equal to the allowed set so the model never wastes
  // turns calling a tool that read-only enforcement would reject.
  if (readonlyMode) {
    tools = tools.filter((t) =>
      isToolAllowedInReadonlyMode(t.name, {
        mcpAnnotations: t.name.startsWith('mcp__')
          ? getMcpToolMeta(t.name)?.annotations
          : undefined,
      }),
    )
  }
  return tools
}

export async function runAgent(
  threadId: string,
  userPrompt: UserContent,
  priorMessages: LLMMessage[],
  host: AgentHost,
  registry: ToolRegistry,
  options?: { invokedSkills?: string[]; priorTodos?: TodoItem[]; workingBrief?: string },
): Promise<{ usage: { inputTokens: number; outputTokens: number }; messages: LLMMessage[] }> {
  const model = getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
  recordThreadModel(threadId, model)
  const remoteProvider = parseRemoteAgentModel(model)

  const sendChunk = createAgentChunkSink(threadId, host)

  if (remoteProvider) {
    const controller = new AbortController()
    abortMap.set(threadId, controller)
    setActiveRunThread(threadId)
    const runAbort = createAgentRunAbortScheduler(controller)
    runAbort.schedule()
    try {
      const result = await runRemoteAgentFromSettings({
        threadId,
        provider: remoteProvider,
        userPrompt,
        priorMessages,
        signal: controller.signal,
        onChunk: sendChunk,
      })
      return {
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        messages: [
          ...priorMessages,
          { role: 'user' as const, content: userPrompt },
          ...result.messages,
        ],
      }
    } catch (err) {
      const msg = classifyAgentError(err)
      sendChunk({ type: 'text', text: msg })
      sendChunk({ type: 'done' })
      return {
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [...priorMessages, { role: 'user' as const, content: userPrompt }],
      }
    } finally {
      runAbort.clear()
      clearActiveRunThread(threadId)
      abortMap.delete(threadId)
    }
  }

  let trimmed: LLMMessage[] = [...priorMessages, { role: 'user', content: userPrompt }]
  let inputTokens = 0
  let outputTokens = 0

  const controller = new AbortController()
  abortMap.set(threadId, controller)
  setActiveRunThread(threadId)
  const runAbort = createAgentRunAbortScheduler(controller)
  runAbort.schedule()

  try {
    const invokedSkills = options?.invokedSkills ?? []
    const subagentsEnabled = getSetting<boolean>('subagentsEnabled', true)
    const contextWindow = await resolveContextWindow(model)
    const toolSchemaReserve = model === 'lm-studio' || model.startsWith('lmstudio:') ? 2_500 : 1_000
    const provider = await buildProvider(model)
    const subagentRoute = subagentsEnabled ? await buildSubagentRoute(model) : null
    const subagentUsageModel = subagentRoute?.usageModel ?? model

    // Set when the turn runs any file-mutating tool, gating the post-turn review.
    let turnChangedFiles = false
    // The agent loop's terminal `done` chunk is held back until the post-turn
    // review finishes, so the thread doesn't flip to idle (and drain its queued
    // messages) while the review is still running.
    let deferredDone: Extract<StreamChunk, { type: 'done' }> | null = null

    const systemPrompt = await buildSystemPrompt({ subagentsEnabled, invokedSkills })

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...priorMessages,
      { role: 'user', content: userPrompt },
    ]

    const parentGoal = resolveParentGoal(options?.workingBrief, messages, userPrompt)

    const userTextForSteering =
      typeof userPrompt === 'string'
        ? userPrompt
        : resolveParentGoal(undefined, messages, userPrompt)
    const steeringBlocks: string[] = []
    if (shouldSteerTodos(userTextForSteering)) steeringBlocks.push(TODO_STEERING_PROMPT)
    if (shouldSteerGithubLinks(userTextForSteering)) {
      const repoSlug = await getGithubRepoSlug()
      steeringBlocks.push(buildGithubLinkSteeringPrompt(repoSlug))
    }
    if (shouldSteerCommit(userTextForSteering)) steeringBlocks.push(buildCommitSteeringPrompt())
    if (steeringBlocks.length && messages[0]?.role === 'system') {
      messages[0] = {
        role: 'system',
        content: (messages[0].content) + `\n\n${steeringBlocks.join('\n\n')}`,
      }
    }
    const priorTodos = options?.priorTodos ?? []
    if (priorTodos.length && messages[0]?.role === 'system') {
      messages[0] = {
        role: 'system',
        content: (messages[0].content) + formatTodosForPrompt(priorTodos),
      }
    }

    const prepared = prepareAgentHistory(messages, contextWindow, toolSchemaReserve)
    trimmed = prepared.trimmed
    const { wasTrimmed, conversationBudget } = prepared
    const { notifyTrimmed } = createTrimNotifier(wasTrimmed)
    const sendTrimNotice = () => {
      sendChunk(contextTrimmedChunk(trimmed, contextWindow, prepared.historyBudget))
    }
    if (wasTrimmed) notifyTrimmed(sendTrimNotice)

    sendChunk(contextPressureChunk(prepared, contextWindow))

    // A single turn that overflows the context even after trimming can never
    // succeed: the trimmer cannot drop the user's own message, so sending it
    // only earns a provider "context length" rejection and, on metered
    // providers, burns input-token rate-limit budget on a doomed request.
    // Fail fast with actionable guidance instead.
    if (promptExceedsContextWindow(prepared, contextWindow)) {
      sendChunk({
        type: 'text',
        text: oversizedTurnMessage(contextWindow, prepared.estimatedPromptTokens),
      })
      sendChunk({ type: 'done' })
      return {
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: trimmed.filter((m) => m.role !== 'system'),
      }
    }

    const runReadLimits = readFileLimitsFromConversationBudget(conversationBudget)
    const readonlyMode = getSetting<boolean>('defaultReadonlyMode', false)

    resetSubagentUsage()

    setAgentRunTodoContext({
      initial: priorTodos,
      onUpdate: (todos) => {
        sendChunk({ type: 'todo_update', todos })
      },
    })

    setTodoToolPostProcess(async (before, after) => {
      let todos = after
      let extraMessage: string | undefined

      const localItem = findNewlyInProgressLocal(before, after)
      if (
        localItem &&
        shouldRouteToLocal(localItem, {
          localTodoItemsEnabled: getSetting<boolean>('localTodoItemsEnabled', true),
          parentIsLocal: isLocalChatModel(model),
        }) &&
        subagentRoute
      ) {
        sendChunk({ type: 'todo_worker_start', todoId: localItem.id, content: localItem.content })
        try {
          const worker = await runTodoWorker({
            item: localItem,
            provider: subagentRoute.provider,
            registry,
            contextWindow: subagentRoute.contextWindow,
            toolSchemaReserve: subagentRoute.toolSchemaReserve,
            signal: controller.signal,
            onChunk: sendChunk,
          })
          inputTokens += worker.usage.inputTokens
          outputTokens += worker.usage.outputTokens
          sendChunk({
            type: 'usage',
            model: subagentUsageModel,
            inputTokens: worker.usage.inputTokens,
            outputTokens: worker.usage.outputTokens,
          })

          let passed = true
          if (localItem.check) {
            const check = await verifyTodoCheck(localItem.check, controller.signal)
            passed = check.passed
            extraMessage = passed
              ? `Local worker completed "${localItem.content}" (${check.detail})`
              : `Local worker finished but check failed: ${check.detail}`
          }

          todos = todos.map((t) =>
            t.id === localItem.id ? { ...t, status: passed ? 'completed' : 'in_progress' } : t,
          )
          sendChunk({ type: 'todo_update', todos })
          sendChunk({
            type: 'todo_worker_done',
            todoId: localItem.id,
            summary: worker.summary,
            passed,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          extraMessage = `Local worker failed: ${msg}`
          sendChunk({
            type: 'todo_worker_done',
            todoId: localItem.id,
            summary: msg,
            passed: false,
          })
        }
      }

      const completed = findNewlyCompleted(before, todos)
      if (completed && compactAtTodoBoundary(trimmed, todos)) {
        notifyTrimmed(sendTrimNotice)
      }

      return { todos, ...(extraMessage ? { extraMessage } : {}) }
    })

    await runWithAgentRunReadonly(readonlyMode, async () => {
      await runWithAgentRunReadFileLimits(runReadLimits, async () => {
        await runAgentLoop({
          provider,
          messages: trimmed,
          tools: parentTools(registry, subagentsEnabled, readonlyMode),
          usageModel: model,
          maxLlmCalls: DEFAULT_MAX_LLM_CALLS,
          runDeadline: runAbort.deadline,
          onRunDeadlineActivity: runAbort.schedule,
          coerceTextToolCallArgs: (name, args) => registry.tryCoerceArgs(name, args),
          getOpenTodos: () => getAgentRunTodos(),
          executeTool: async (name, args, signal, toolCallId) => {
            if (isEditTool(name)) turnChangedFiles = true
            if (name === 'explore' && subagentsEnabled) {
              setExploreSubagentContext({
                parentToolCallId: toolCallId,
                parentGoal,
                provider: subagentRoute?.provider ?? provider,
                registry,
                contextWindow: subagentRoute?.contextWindow ?? contextWindow,
                toolSchemaReserve: subagentRoute?.toolSchemaReserve ?? toolSchemaReserve,
                onChunk: sendChunk,
                usageModel: subagentUsageModel,
              })
              try {
                return await registry.execute(name, args, signal)
              } finally {
                setExploreSubagentContext(null)
              }
            }
            if (name === 'investigate_ci' && subagentsEnabled) {
              setCiInvestigatorContext({
                parentToolCallId: toolCallId,
                parentGoal,
                provider: subagentRoute?.provider ?? provider,
                registry,
                contextWindow: subagentRoute?.contextWindow ?? contextWindow,
                toolSchemaReserve: subagentRoute?.toolSchemaReserve ?? toolSchemaReserve,
                onChunk: sendChunk,
                usageModel: subagentUsageModel,
              })
              try {
                return await registry.execute(name, args, signal)
              } finally {
                setCiInvestigatorContext(null)
              }
            }
            return registry.executeNormalized(name, args, signal)
          },
          signal: controller.signal,
          maxContextTokens: contextWindow,
          toolSchemaReserveTokens: toolSchemaReserve,
          onHistoryTrimmed: () => notifyTrimmed(sendTrimNotice),
          getLastUsage: () => (hasLastUsage(provider) ? provider.lastUsage : null),
          onChunk: (chunk) => {
            if (chunk.type === 'done') {
              deferredDone = chunk
              return
            }
            sendChunk(chunk)
            if (chunk.type === 'usage') {
              inputTokens += chunk.inputTokens
              outputTokens += chunk.outputTokens
            }
          },
        })

        const subUsage = getAccumulatedSubagentUsage()
        if (subUsage.inputTokens || subUsage.outputTokens) {
          inputTokens += subUsage.inputTokens
          outputTokens += subUsage.outputTokens
          sendChunk({
            type: 'usage',
            model: subagentUsageModel,
            inputTokens: subUsage.inputTokens,
            outputTokens: subUsage.outputTokens,
            ...(subUsage.cacheReadTokens !== undefined
              ? { cacheReadTokens: subUsage.cacheReadTokens }
              : {}),
            ...(subUsage.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: subUsage.cacheCreationTokens }
              : {}),
          })
        }
      })
    })

    // Post-turn review: when this turn changed files, run a read-only review
    // subagent over the working diff and surface its verdict. Runs before the
    // deferred `done` so the thread stays "running" until the review lands.
    if (turnChangedFiles && getSetting<boolean>('postTurnReviewEnabled', true)) {
      sendChunk({ type: 'post_turn_review', status: 'running', summary: '' })
      try {
        const reviewRoute = await buildReviewRoute()
        const reviewUsageModel = reviewRoute?.usageModel ?? model
        const review = await runPostTurnReview({
          parentGoal,
          provider: reviewRoute?.provider ?? provider,
          registry,
          contextWindow: reviewRoute?.contextWindow ?? contextWindow,
          toolSchemaReserve: reviewRoute?.toolSchemaReserve ?? toolSchemaReserve,
          signal: controller.signal,
          usageModel: reviewUsageModel,
          onUsage: (u) => {
            inputTokens += u.inputTokens
            outputTokens += u.outputTokens
            sendChunk({
              type: 'usage',
              model: reviewUsageModel,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
            })
          },
        })
        sendChunk({ type: 'post_turn_review', status: 'done', summary: review.summary })
      } catch (err) {
        const detail = controller.signal.aborted ? 'Review cancelled.' : classifyAgentError(err)
        sendChunk({ type: 'post_turn_review', status: 'error', summary: detail })
      }
    }

    sendChunk(deferredDone ?? { type: 'done' })
  } catch (err) {
    const msg = classifyAgentError(err)
    sendChunk({ type: 'text', text: msg })
    sendChunk({ type: 'done' })
  } finally {
    runAbort.clear()
    clearAgentRunTodos()
    setTodoToolPostProcess(null)
    clearActiveRunThread(threadId)
    abortMap.delete(threadId)
  }

  const updatedHistory = trimmed.filter((m) => m.role !== 'system')
  return { usage: { inputTokens, outputTokens }, messages: updatedHistory }
}

export function abortAgent(threadId: string): void {
  abortMap.get(threadId)?.abort()
}
