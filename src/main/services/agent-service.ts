import { BrowserWindow } from 'electron'
import { createProvider, createLMStudioProvider } from '@shared/llm/create-provider.ts'
import { runAgentLoop } from '@shared/agent/run-agent-loop.ts'
import { AGENT_RUN_TIMEOUT_MS, DEFAULT_MAX_LLM_CALLS } from '@shared/agent/agent-loop-limits.ts'
import { loadProjectInstructions } from './project-instructions.ts'
import type { LLMMessage, LLMProvider, StreamChunk, UserContent } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { LM_STUDIO_MODEL_IDS, DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { getSetting, getApiKey, getLmStudioApiKey } from './settings.ts'
import { getWorkspaceRoot } from './workspace.ts'
import {
  buildInvokedSkillsBlock,
  buildSkillsCatalogBlock,
  buildSkillsToolsPromptLine,
} from './skill-prompt.ts'
import { resolveContextWindow } from './resolve-context-window.ts'
import {
  fetchLmStudioModelsCached,
  invalidateLmStudioModelsCache as invalidateLmStudioModelsCacheImpl,
} from './lm-studio-models.ts'
import { classifyAgentError } from './agent-errors.ts'
import {
  prepareAgentHistory,
  contextTrimmedChunk,
  contextPressureChunk,
  createTrimNotifier,
} from './history-trimming.ts'
import {
  runWithAgentRunReadFileLimits,
  getAgentRunReadFileLimits,
  readFileLimitsFromConversationBudget,
} from './agent-run-read-limits.ts'
import { formatReadFileLimitHint } from '@shared/agent/read-file-limits.ts'
import {
  setExploreSubagentContext,
  resetSubagentUsage,
  getAccumulatedSubagentUsage,
} from './explore-subagent-runner.ts'
import { isLocalModel } from '@shared/llm/estimate-cost.ts'
import { buildSemanticSearchPromptBlock } from './semantic-search.ts'
import { setAgentRunTodoContext, clearAgentRunTodos, getAgentRunTodos } from './agent-run-todos.ts'
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

const abortMap = new Map<string, AbortController>()

const PARENT_DELEGATED_TOOLS = [
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'find_files',
] as const

// The subagents-enabled and direct-reads prompts share their structure and most
// of their rules; they differ only in the available tools and whether context is
// gathered via `explore` or direct reads/searches. Keep the shared wording (and
// the modifying-files rules) in one place and vary the rest.
const SHARED_TOOL_TAIL = `- git_status: Show working tree status
- git_diff: Show unstaged or staged changes
- git_log: Show recent commit history
- run_shell: Run a shell command in the workspace (may prompt for approval)
- update_todos: Create or update a structured multi-step plan (use only for complex multi-step work)`

interface BasePromptVars {
  /** Mode-specific tool lines listed above the shared git/run_shell tail. */
  tools: string
  /** Open-ended question, step 1: how to gather context. */
  gather: string
  /** Open-ended question, step 3: avoid redoing the same work. */
  avoidRepeat: string
  /** Modifying files, step 1: understand the file first. */
  understand: string
  /** Verb used in "always <verb> before writing" (explore vs read). */
  inspectVerb: string
}

function buildBasePrompt(v: BasePromptVars): string {
  return `You are a coding assistant with access to the user's local workspace.

Available tools:
${v.tools}
${SHARED_TOOL_TAIL}
{SKILLS_TOOLS_LINE}
Working directory: {WORKSPACE_ROOT}

When the user asks an open-ended question (review, explain, validate, summarize):
1. ${v.gather}
2. Do not end the turn with tool calls alone — always follow exploration with a summary for the user.
3. ${v.avoidRepeat}

When modifying files:
1. ${v.understand}
2. Use str_replace for partial edits or write_file for full rewrites — the user sees a diff and must approve
3. Do not assume file content; always ${v.inspectVerb} before writing
4. Generated code must be runnable: include the imports, dependencies, and wiring it needs to run
5. When you make an edit, use str_replace or write_file rather than pasting the file's new contents into the chat
6. If the same error persists after two attempts to fix it, stop and ask the user instead of trying again`
}

const BASE_SYSTEM_PROMPT = buildBasePrompt({
  tools: `- explore: Explore the codebase by reading and searching files (returns a summary — use this instead of reading files directly)
- write_file: Propose writing a file (user approves the diff before it's written)
- str_replace: Replace a unique substring in a file (user approves the diff; prefer over write_file for small edits)`,
  gather:
    'Use explore to read or search the codebase, then finish with a clear written answer in plain language.',
  avoidRepeat:
    'Do not re-explore the same areas repeatedly. Run tests or commands with run_shell when asked to validate code.',
  understand: 'Use explore to understand the file before changing it',
  inspectVerb: 'explore',
})

const BASE_SYSTEM_PROMPT_DIRECT_READS = buildBasePrompt({
  tools: `- read_file: Read a file from the workspace
- write_file: Propose writing a file (user approves the diff before it's written)
- str_replace: Replace a unique substring in a file (user approves the diff; prefer over write_file for small edits)
- list_dir: List directory contents
- search_codebase: Search by regex or meaning (auto-selects; prefer over search_code)
- semantic_search: Search by meaning only (native codesearch/vera index)
- search_code: Search for text/regex patterns (indexed grep when available, otherwise ripgrep)
- find_files: Find files by name or glob pattern`,
  gather: 'Use tools as needed, then finish with a clear written answer in plain language.',
  avoidRepeat:
    'List the workspace root at most once; do not re-read the same paths. Then run tests or commands with run_shell when asked to validate code.',
  understand: 'Read the file first',
  inspectVerb: 'read',
})

// Optional steering, toggled by the `externalApiSafety` setting. Kept short and
// appended near the top of the system prompt so it sits ahead of workspace- and
// user-supplied instructions.
const EXTERNAL_API_SAFETY_BLOCK = `

When adding code that calls an external API or pulls in a dependency:
- Choose a package or API version compatible with the project; check the existing manifest/lockfile before picking one.
- Never hardcode, commit, or log secrets or API keys. Read them from environment variables or the project's existing config/secret store.`

const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234/v1'

function storedOrEnvApiKey(provider: 'anthropic' | 'openai'): string | null {
  if (provider === 'anthropic')
    return getApiKey('anthropic') ?? process.env.ANTHROPIC_API_KEY ?? null
  return getApiKey('openai') ?? process.env.OPENAI_API_KEY ?? null
}

export function isLocalChatModel(model: string): boolean {
  return isLocalModel(model)
}

async function resolveSubagentLocalModelId(url: string): Promise<string | null> {
  const configured = getSetting<string>('lmStudioSubagentModel', '').trim()
  if (configured) return configured
  const fallback = getSetting<string>('lmStudioModel', LM_STUDIO_MODEL_IDS.chat).trim()
  if (fallback) return fallback
  return fetchFirstLocalModel(url)
}

interface SubagentRoute {
  provider: LLMProvider
  usageModel: string
  contextWindow: number
  toolSchemaReserve: number
}

/** When the parent chat uses a cloud model, route explore subagents to LM Studio. */
export async function buildSubagentRoute(parentModel: string): Promise<SubagentRoute | null> {
  if (isLocalChatModel(parentModel)) return null
  if (!getSetting<boolean>('lmStudioForSubagents', true)) return null

  const url = getSetting<string>('lmStudioUrl', DEFAULT_LM_STUDIO_URL)
  const modelId = await resolveSubagentLocalModelId(url)
  if (!modelId) return null

  const contextWindow = await resolveContextWindow(`lmstudio:${modelId}`)
  return {
    provider: createLMStudioProvider(url, modelId, getLmStudioApiKey()),
    usageModel: `lmstudio:${modelId}`,
    contextWindow,
    toolSchemaReserve: 2_500,
  }
}

// Builds the provider for the main agent loop. LM Studio models are encoded as
// `lmstudio:<modelId>`; the legacy `lm-studio` value resolves to the configured
// model or the first one the server has loaded (never the bogus "local-model").
async function buildProvider(model: string): Promise<LLMProvider> {
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = getSetting<string>('lmStudioUrl', DEFAULT_LM_STUDIO_URL)
    let id = model.startsWith('lmstudio:')
      ? model.slice('lmstudio:'.length)
      : getSetting<string>('lmStudioModel', LM_STUDIO_MODEL_IDS.chat)
    if (!id) id = (await fetchFirstLocalModel(url)) ?? ''
    if (!id) {
      throw new Error(
        'No LM Studio model available. Open Settings → LM Studio, check the server URL/API key, and pick a model.',
      )
    }
    return createLMStudioProvider(url, id, getLmStudioApiKey())
  }
  if (process.env.COPSE_PANEL_MOCK_LLM === '1') return createProvider(model)
  if (model.startsWith('claude')) {
    return createProvider(model, {
      anthropicApiKey: storedOrEnvApiKey('anthropic'),
    })
  }
  if (model.startsWith('gpt')) {
    return createProvider(model, {
      openAiApiKey: storedOrEnvApiKey('openai'),
    })
  }
  return createProvider(model, {
    anthropicApiKey: storedOrEnvApiKey('anthropic'),
    openAiApiKey: storedOrEnvApiKey('openai'),
  })
}

// List the model ids an LM Studio server currently exposes (using saved URL/key).
export async function listLmStudioModels(): Promise<string[]> {
  const url = getSetting<string>('lmStudioUrl', DEFAULT_LM_STUDIO_URL)
  const r = await fetchLmStudioModelsCached(url)
  return r.ok ? r.models.map((m) => m.id) : []
}

// Drop the cache so the next models query refetches (e.g. right after a manual
// "Test connection" succeeds, or settings change).
export function invalidateLmStudioModelsCache(): void {
  invalidateLmStudioModelsCacheImpl()
}

interface ProviderWithUsage {
  lastUsage: { inputTokens: number; outputTokens: number } | null
}
function hasLastUsage(p: unknown): p is ProviderWithUsage {
  return typeof p === 'object' && p !== null && 'lastUsage' in p
}

function extractParentGoal(messages: LLMMessage[], userPrompt: UserContent): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  if (lastUser && typeof lastUser.content === 'string') return lastUser.content.slice(0, 2000)
  if (typeof userPrompt === 'string') return userPrompt.slice(0, 2000)
  return '(complex user input)'
}

function parentTools(registry: ToolRegistry, subagentsEnabled: boolean) {
  const tools = registry.toLLMTools()
  if (!subagentsEnabled) {
    return tools
      .filter((t) => t.name !== 'explore')
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
  }
  const excluded = new Set<string>(PARENT_DELEGATED_TOOLS)
  return tools.filter((t) => !excluded.has(t.name))
}

export async function runAgent(
  threadId: string,
  userPrompt: UserContent,
  priorMessages: LLMMessage[],
  mainWindow: BrowserWindow,
  registry: ToolRegistry,
  options?: { invokedSkills?: string[]; priorTodos?: TodoItem[] },
): Promise<{ usage: { inputTokens: number; outputTokens: number }; messages: LLMMessage[] }> {
  const skillsToolsLine = buildSkillsToolsPromptLine()
  const projectInstructions = await loadProjectInstructions()
  const invokedSkills = options?.invokedSkills ?? []

  const model = getSetting<string>('model', DEFAULT_APP_CHAT_MODEL)
  const subagentsEnabled = getSetting<boolean>('subagentsEnabled', true)
  const contextWindow = await resolveContextWindow(model)
  const toolSchemaReserve = model === 'lm-studio' || model.startsWith('lmstudio:') ? 2_500 : 1_000

  // Build the provider per run so a freshly-saved API key (now in process.env)
  // and the currently-selected model take effect without a restart.
  const provider = await buildProvider(model)
  const subagentRoute = subagentsEnabled ? await buildSubagentRoute(model) : null
  const subagentUsageModel = subagentRoute?.usageModel ?? model

  const basePrompt = subagentsEnabled ? BASE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT_DIRECT_READS
  const externalApiSafety = getSetting<boolean>('externalApiSafety', false)
  const customInstructions = getSetting<string>('customInstructions', '').trim()
  const systemPrompt =
    basePrompt
      .replace('{SKILLS_TOOLS_LINE}', skillsToolsLine)
      .replace('{WORKSPACE_ROOT}', getWorkspaceRoot() ?? '(none)') +
    (externalApiSafety ? EXTERNAL_API_SAFETY_BLOCK : '') +
    buildSkillsCatalogBlock() +
    (await buildInvokedSkillsBlock(invokedSkills)) +
    buildSemanticSearchPromptBlock() +
    (customInstructions ? `\n\n---\n\n## Custom instructions\n\n${customInstructions}` : '') +
    (projectInstructions ? `\n\n---\n\n## Project instructions\n\n${projectInstructions}` : '')

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: userPrompt },
  ]

  const parentGoal = extractParentGoal(messages, userPrompt)

  const userTextForSteering =
    typeof userPrompt === 'string' ? userPrompt : extractParentGoal(messages, userPrompt)
  const todoSteering = shouldSteerTodos(userTextForSteering) ? `\n\n${TODO_STEERING_PROMPT}` : ''
  if (todoSteering && messages[0]?.role === 'system') {
    messages[0] = {
      role: 'system',
      content: (messages[0].content as string) + todoSteering,
    }
  }
  const priorTodos = options?.priorTodos ?? []
  if (priorTodos.length && messages[0]?.role === 'system') {
    messages[0] = {
      role: 'system',
      content: (messages[0].content as string) + formatTodosForPrompt(priorTodos),
    }
  }

  const prepared = prepareAgentHistory(messages, contextWindow, toolSchemaReserve)
  const { trimmed, wasTrimmed, conversationBudget } = prepared
  const { notifyTrimmed } = createTrimNotifier(wasTrimmed)
  const sendTrimNotice = () => {
    mainWindow.webContents.send(
      'agent:chunk',
      threadId,
      contextTrimmedChunk(trimmed, contextWindow, prepared.historyBudget),
    )
  }
  if (wasTrimmed) notifyTrimmed(sendTrimNotice)

  mainWindow.webContents.send(
    'agent:chunk',
    threadId,
    contextPressureChunk(prepared, contextWindow),
  )
  const runReadLimits = readFileLimitsFromConversationBudget(conversationBudget)

  const controller = new AbortController()
  abortMap.set(threadId, controller)
  const runTimeoutTimer = setTimeout(() => controller.abort(), AGENT_RUN_TIMEOUT_MS)

  let inputTokens = 0,
    outputTokens = 0

  resetSubagentUsage()
  const sendChunk = (chunk: StreamChunk) => {
    mainWindow.webContents.send('agent:chunk', threadId, chunk)
  }

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
        lmStudioForTodoItems: getSetting<boolean>('lmStudioForTodoItems', true),
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

  try {
    await runWithAgentRunReadFileLimits(runReadLimits, async () => {
      await runAgentLoop({
        provider,
        messages: trimmed,
        tools: parentTools(registry, subagentsEnabled),
        usageModel: model,
        maxLlmCalls: DEFAULT_MAX_LLM_CALLS,
        runTimeoutMs: AGENT_RUN_TIMEOUT_MS,
        coerceTextToolCallArgs: (name, args) => registry.tryCoerceArgs(name, args),
        getOpenTodos: () => getAgentRunTodos(),
        executeTool: async (name, args, signal, toolCallId) => {
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
          return registry.execute(name, args, signal)
        },
        signal: controller.signal,
        maxContextTokens: contextWindow,
        toolSchemaReserveTokens: toolSchemaReserve,
        onHistoryTrimmed: () => notifyTrimmed(sendTrimNotice),
        getLastUsage: () => (hasLastUsage(provider) ? provider.lastUsage : null),
        onChunk: (chunk) => {
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
        })
      }
    })
  } catch (err) {
    const msg = classifyAgentError(err)
    mainWindow.webContents.send('agent:chunk', threadId, {
      type: 'text',
      text: msg,
    } satisfies StreamChunk)
    mainWindow.webContents.send('agent:chunk', threadId, { type: 'done' } satisfies StreamChunk)
  } finally {
    clearTimeout(runTimeoutTimer)
    clearAgentRunTodos()
    setTodoToolPostProcess(null)
    abortMap.delete(threadId)
  }

  // Usage is streamed per LLM step via agent:chunk (type: usage).
  // Return non-system messages for history persistence in main process
  const updatedHistory = trimmed.filter((m) => m.role !== 'system')
  return { usage: { inputTokens, outputTokens }, messages: updatedHistory }
}

export function abortAgent(threadId: string): void {
  abortMap.get(threadId)?.abort()
}

// Test connectivity to an LM Studio (OpenAI-compatible) server by listing its
// models. Local-only, no billing — safe to call freely.
export async function testLmStudio(
  url: string,
  apiKey?: string,
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  invalidateLmStudioModelsCacheImpl()
  const r = await fetchLmStudioModelsCached(url, apiKey)
  if (!r.ok) {
    return { ok: false, error: r.error ?? 'Could not list models' }
  }
  return { ok: true, models: r.models.map((m) => m.id) }
}

// Fetch the first model id a local OpenAI-compatible server has loaded.
async function fetchFirstLocalModel(baseURL: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${getLmStudioApiKey()}` },
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    return json.data?.[0]?.id ?? null
  } catch {
    return null
  }
}

// Collect a non-streaming-ish completion as plain text from any provider.
async function completeText(provider: LLMProvider, prompt: string): Promise<string> {
  const messages: LLMMessage[] = [{ role: 'user', content: prompt }]
  let out = ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    for await (const chunk of provider.stream(messages, [], controller.signal)) {
      if (chunk.type === 'text') out += chunk.text
    }
  } finally {
    clearTimeout(timer)
  }
  return out
}

// Generate a short thread title from the first user message. Prefers a local
// LM Studio server (cheap, fast) for this small task; returns null on failure so
// the caller can fall back to a heuristic.
export async function suggestThreadTitle(text: string): Promise<string | null> {
  const useLmStudio = getSetting<boolean>('lmStudioForSmallTasks', true)
  const lmUrl = getSetting<string>('lmStudioUrl', DEFAULT_LM_STUDIO_URL)

  let provider: LLMProvider | null = null
  if (useLmStudio && lmUrl) {
    const configured =
      getSetting<string>('lmStudioSmallTasksModel', LM_STUDIO_MODEL_IDS.smallTasks).trim() ||
      getSetting<string>('lmStudioModel', LM_STUDIO_MODEL_IDS.chat).trim()
    const model = configured || (await fetchFirstLocalModel(lmUrl))
    if (model) provider = createLMStudioProvider(lmUrl, model, getLmStudioApiKey())
  }
  // Fall back to the main provider only if a real cloud key is configured.
  if (!provider && (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) {
    provider = await buildProvider(getSetting<string>('model', DEFAULT_APP_CHAT_MODEL))
  }
  if (!provider) return null

  const prompt =
    'Reply with ONLY a concise 3-5 word title in Title Case for the following request. ' +
    'No quotes, no trailing punctuation.\n\nRequest:\n' +
    text.slice(0, 500)
  try {
    const out = await completeText(provider, prompt)
    const title = out
      .trim()
      .split('\n')[0]!
      .replace(/^["'#\s-]+|["'.\s]+$/g, '')
      .slice(0, 60)
    return title || null
  } catch {
    return null
  }
}
