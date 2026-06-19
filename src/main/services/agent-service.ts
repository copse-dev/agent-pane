import { BrowserWindow } from 'electron'
import { createProvider, createLMStudioProvider } from '@shared/llm/create-provider.ts'
import { runAgentLoop } from '@shared/agent/run-agent-loop.ts'
import { loadProjectInstructions } from './project-instructions.ts'
import type { LLMMessage, LLMProvider, StreamChunk, UserContent } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { getSetting, getApiKey } from './settings.ts'
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
import {
  trimHistory,
  historyTokenBudget,
  estimateMessageTokens,
  conversationTokenBudget,
} from '@shared/agent/trim-history.ts'
import {
  clearAgentRunReadFileLimits,
  setAgentRunReadFileLimits,
  getAgentRunReadFileLimits,
} from './agent-run-read-limits.ts'
import { formatReadFileLimitHint } from '@shared/agent/read-file-limits.ts'
import {
  setExploreSubagentContext,
  resetSubagentUsage,
  getAccumulatedSubagentUsage,
} from './explore-subagent-runner.ts'

const abortMap = new Map<string, AbortController>()

const PARENT_DELEGATED_TOOLS = ['read_file', 'list_dir', 'search_code', 'find_files'] as const

const BASE_SYSTEM_PROMPT = `You are a coding assistant with access to the user's local workspace.

Available tools:
- explore: Explore the codebase by reading and searching files (returns a summary — use this instead of reading files directly)
- write_file: Propose writing a file (user approves the diff before it's written)
- git_status: Show working tree status
- git_diff: Show unstaged or staged changes
- git_log: Show recent commit history
- run_shell: Run a shell command (auto-runs when contained in the sandbox; prompts for network/outside access)
{SKILLS_TOOLS_LINE}
Working directory: {WORKSPACE_ROOT}

When the user asks an open-ended question (review, explain, validate, summarize):
1. Use explore to read or search the codebase, then finish with a clear written answer in plain language.
2. Do not end the turn with tool calls alone — always follow exploration with a summary for the user.
3. Do not re-explore the same areas repeatedly. Run tests or commands with run_shell when asked to validate code.

When modifying files:
1. Use explore to understand the file before changing it
2. Use write_file to propose changes — the user sees a diff and must approve
3. Do not assume file content; always explore before writing`

const BASE_SYSTEM_PROMPT_DIRECT_READS = `You are a coding assistant with access to the user's local workspace.

Available tools:
- read_file: Read a file from the workspace
- write_file: Propose writing a file (user approves the diff before it's written)
- list_dir: List directory contents
- search_code: Search for text/regex patterns using ripgrep
- find_files: Find files by name or glob pattern
- git_status: Show working tree status
- git_diff: Show unstaged or staged changes
- git_log: Show recent commit history
- run_shell: Run a shell command (auto-runs when contained in the sandbox; prompts for network/outside access)
{SKILLS_TOOLS_LINE}
Working directory: {WORKSPACE_ROOT}

When the user asks an open-ended question (review, explain, validate, summarize):
1. Use tools as needed, then finish with a clear written answer in plain language.
2. Do not end the turn with tool calls alone — always follow exploration with a summary for the user.
3. List the workspace root at most once; do not re-read the same paths. Then run tests or commands with run_shell when asked to validate code.

When modifying files:
1. Read the file first
2. Use write_file to propose changes — the user sees a diff and must approve
3. Do not assume file content; always read before writing`

const DEFAULT_LM_STUDIO_URL = 'http://localhost:1234/v1'

function lmStudioKey(): string {
  return getApiKey('lmstudio') ?? 'lm-studio'
}

// Builds the provider for the main agent loop. LM Studio models are encoded as
// `lmstudio:<modelId>`; the legacy `lm-studio` value resolves to the configured
// model or the first one the server has loaded (never the bogus "local-model").
async function buildProvider(model: string): Promise<LLMProvider> {
  if (model === 'lm-studio' || model.startsWith('lmstudio:')) {
    const url = getSetting<string>('lmStudioUrl', DEFAULT_LM_STUDIO_URL)
    let id = model.startsWith('lmstudio:')
      ? model.slice('lmstudio:'.length)
      : getSetting<string>('lmStudioModel', '')
    if (!id) id = (await fetchFirstLocalModel(url)) ?? ''
    if (!id) {
      throw new Error(
        'No LM Studio model available. Open Settings → LM Studio, check the server URL/API key, and pick a model.',
      )
    }
    return createLMStudioProvider(url, id, lmStudioKey())
  }
  return createProvider(model)
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
  options?: { invokedSkills?: string[] },
): Promise<{ usage: { inputTokens: number; outputTokens: number }; messages: LLMMessage[] }> {
  const skillsToolsLine = buildSkillsToolsPromptLine()
  const projectInstructions = await loadProjectInstructions()
  const invokedSkills = options?.invokedSkills ?? []

  const model = getSetting<string>('model', 'claude-sonnet-4-6')
  const subagentsEnabled = getSetting<boolean>('subagentsEnabled', true)
  const contextWindow = await resolveContextWindow(model)
  const toolSchemaReserve = model === 'lm-studio' || model.startsWith('lmstudio:') ? 2_500 : 1_000
  const historyBudget = historyTokenBudget(contextWindow, { reserveTokens: toolSchemaReserve })

  // Build the provider per run so a freshly-saved API key (now in process.env)
  // and the currently-selected model take effect without a restart.
  const provider = await buildProvider(model)

  const basePrompt = subagentsEnabled ? BASE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT_DIRECT_READS
  const systemPrompt =
    basePrompt
      .replace('{SKILLS_TOOLS_LINE}', skillsToolsLine)
      .replace('{WORKSPACE_ROOT}', getWorkspaceRoot() ?? '(none)') +
    buildSkillsCatalogBlock() +
    (await buildInvokedSkillsBlock(invokedSkills)) +
    (projectInstructions ? `\n\n---\n\n## Project instructions\n\n${projectInstructions}` : '')

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: userPrompt },
  ]

  const parentGoal = extractParentGoal(messages, userPrompt)

  const { messages: trimmed, trimmed: wasTrimmed } = trimHistory(messages, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  let trimNoticeSent = wasTrimmed
  const notifyTrimmed = () => {
    if (trimNoticeSent) return
    trimNoticeSent = true
    const estimatedTokens = Math.round(estimateMessageTokens(trimmed))
    mainWindow.webContents.send('agent:chunk', threadId, {
      type: 'context_trimmed',
      contextWindow,
      historyBudget,
      estimatedTokens,
    } satisfies StreamChunk)
  }
  if (wasTrimmed) notifyTrimmed()

  const conversationBudget = conversationTokenBudget(trimmed, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  setAgentRunReadFileLimits(conversationBudget)

  const controller = new AbortController()
  abortMap.set(threadId, controller)

  let inputTokens = 0,
    outputTokens = 0

  resetSubagentUsage()
  const sendChunk = (chunk: StreamChunk) => {
    mainWindow.webContents.send('agent:chunk', threadId, chunk)
  }

  try {
    await runAgentLoop({
      provider,
      messages: trimmed,
      tools: parentTools(registry, subagentsEnabled),
      executeTool: async (name, args, signal, toolCallId) => {
        if (name === 'explore' && subagentsEnabled) {
          setExploreSubagentContext({
            parentToolCallId: toolCallId,
            parentGoal,
            provider,
            registry,
            contextWindow,
            toolSchemaReserve,
            onChunk: sendChunk,
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
      onHistoryTrimmed: notifyTrimmed,
      onChunk: (chunk) => {
        sendChunk(chunk)
        if (chunk.type === 'done' && hasLastUsage(provider)) {
          const u = provider.lastUsage
          const subUsage = getAccumulatedSubagentUsage()
          if (u) {
            inputTokens = u.inputTokens + subUsage.inputTokens
            outputTokens = u.outputTokens + subUsage.outputTokens
          }
        }
      },
    })
  } catch (err) {
    const msg = classifyError(err)
    mainWindow.webContents.send('agent:chunk', threadId, {
      type: 'text',
      text: msg,
    } satisfies StreamChunk)
    mainWindow.webContents.send('agent:chunk', threadId, { type: 'done' } satisfies StreamChunk)
  } finally {
    clearAgentRunReadFileLimits()
    abortMap.delete(threadId)
  }

  // Surface token usage to the renderer so the per-thread cost can be shown.
  if (inputTokens || outputTokens) {
    mainWindow.webContents.send('agent:usage', threadId, { inputTokens, outputTokens })
  }

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
      headers: { Authorization: `Bearer ${lmStudioKey()}` },
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
      getSetting<string>('lmStudioSmallTasksModel', '').trim() ||
      getSetting<string>('lmStudioModel', '').trim()
    const model = configured || (await fetchFirstLocalModel(lmUrl))
    if (model) provider = createLMStudioProvider(lmUrl, model, lmStudioKey())
  }
  // Fall back to the main provider only if a real cloud key is configured.
  if (!provider && (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) {
    provider = await buildProvider(getSetting<string>('model', 'claude-sonnet-4-6'))
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

function classifyError(err: unknown): string {
  const s = String(err)
  if (s.includes('401') || s.includes('Unauthorized'))
    return 'The API key was rejected (401). The key reached the provider but was refused — check it is correct and current in Settings, and that no stale `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set in your shell.'
  if (s.includes('429') || s.includes('rate_limit'))
    return 'Rate limit reached. Please wait a moment and try again.'
  if (
    s.includes('context_length') ||
    s.includes('context window') ||
    s.includes('tokens to keep from the initial prompt')
  )
    return 'Conversation too long for the loaded model context. Reload the model in LM Studio with a larger context, start a new thread, or use smaller reads.'
  if (s.includes('No user query found in messages') || s.includes('jinja template'))
    return 'The local model prompt template failed after history was trimmed. Reload the model in LM Studio with enough context for the chat template, or use a model with a fixed chat template (e.g. under lmstudio-community).'
  return `An error occurred: ${err instanceof Error ? err.message : s}`
}
