import { BrowserWindow } from 'electron'
import { createProvider, createLMStudioProvider } from '@shared/llm/create-provider.ts'
import { runAgentLoop } from '@shared/agent/run-agent-loop.ts'
import { loadProjectInstructions } from './project-instructions.ts'
import type { LLMMessage, LLMProvider, StreamChunk, UserContent } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { getSetting, getApiKey } from './settings.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { buildInvokedSkillsBlock, buildSkillsCatalogBlock } from './skill-prompt.ts'

const abortMap = new Map<string, AbortController>()

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

// Cache the models list to avoid hammering the server (the renderer asks on
// every footer mount / settings change). Keyed by url+key so changing either
// invalidates it; failures are cached too so an unreachable server doesn't incur
// a 4s timeout on every call.
const LM_MODELS_TTL_MS = 60_000
let lmModelsCache: { key: string; at: number; models: string[] } | null = null

// List the model ids an LM Studio server currently exposes (using saved URL/key).
export async function listLmStudioModels(): Promise<string[]> {
  const url = getSetting<string>('lmStudioUrl', DEFAULT_LM_STUDIO_URL)
  const cacheKey = `${url}${lmStudioKey()}`
  const now = Date.now()
  if (
    lmModelsCache &&
    lmModelsCache.key === cacheKey &&
    now - lmModelsCache.at < LM_MODELS_TTL_MS
  ) {
    return lmModelsCache.models
  }
  const r = await testLmStudio(url)
  const models = r.ok ? (r.models ?? []) : []
  lmModelsCache = { key: cacheKey, at: now, models }
  return models
}

// Drop the cache so the next models query refetches (e.g. right after a manual
// "Test connection" succeeds, or settings change).
export function invalidateLmStudioModelsCache(): void {
  lmModelsCache = null
}

interface ProviderWithUsage {
  lastUsage: { inputTokens: number; outputTokens: number } | null
}
function hasLastUsage(p: unknown): p is ProviderWithUsage {
  return typeof p === 'object' && p !== null && 'lastUsage' in p
}

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-8': 200_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
}

function estimateTokens(messages: LLMMessage[]): number {
  // Rough estimate: 1 token ≈ 4 chars
  return JSON.stringify(messages).length / 4
}

function trimHistory(
  messages: LLMMessage[],
  maxTokens: number,
): { messages: LLMMessage[]; trimmed: boolean } {
  const system = messages.filter((m) => m.role === 'system')
  let rest = messages.filter((m) => m.role !== 'system')

  let trimmed = false
  while (rest.length > 12 && estimateTokens([...system, ...rest]) > maxTokens * 0.8) {
    // Drop oldest pair (user + assistant)
    rest = rest.slice(2)
    trimmed = true
  }

  return { messages: [...system, ...rest], trimmed }
}

const BASE_SYSTEM_PROMPT = `You are a coding assistant with access to the user's local workspace.

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
- read_skill: Read additional files under a skill directory (scripts/, references/, assets/)

Working directory: {WORKSPACE_ROOT}

Skills are invoked manually via /skill-name in the input. Invoked skill instructions are injected automatically; use read_skill for supporting files under a skill directory.

When modifying files:
1. Read the file first
2. Use write_file to propose changes — the user sees a diff and must approve
3. Do not assume file content; always read before writing`

export async function runAgent(
  threadId: string,
  userPrompt: UserContent,
  priorMessages: LLMMessage[],
  mainWindow: BrowserWindow,
  registry: ToolRegistry,
  options?: { invokedSkills?: string[] },
): Promise<{ usage: { inputTokens: number; outputTokens: number }; messages: LLMMessage[] }> {
  const projectInstructions = await loadProjectInstructions()
  const invokedSkills = options?.invokedSkills ?? []
  const systemPrompt =
    BASE_SYSTEM_PROMPT.replace('{WORKSPACE_ROOT}', getWorkspaceRoot() ?? '(none)') +
    buildSkillsCatalogBlock() +
    (await buildInvokedSkillsBlock(invokedSkills)) +
    (projectInstructions ? `\n\n---\n\n## Project instructions\n\n${projectInstructions}` : '')

  const model = getSetting<string>('model', 'claude-sonnet-4-6')
  const contextWindow = MODEL_CONTEXT_WINDOWS[model] ?? 128_000

  // Build the provider per run so a freshly-saved API key (now in process.env)
  // and the currently-selected model take effect without a restart.
  const provider = await buildProvider(model)

  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...priorMessages,
    { role: 'user', content: userPrompt },
  ]

  const { messages: trimmed, trimmed: wasTrimmed } = trimHistory(messages, contextWindow)
  if (wasTrimmed) {
    mainWindow.webContents.send('agent:chunk', threadId, {
      type: 'text',
      text: '\n\n[Earlier conversation trimmed to fit context window]\n\n',
    } satisfies StreamChunk)
  }

  const controller = new AbortController()
  abortMap.set(threadId, controller)

  let inputTokens = 0,
    outputTokens = 0

  try {
    await runAgentLoop({
      provider,
      messages: trimmed,
      tools: registry.toLLMTools(),
      executeTool: (name, args, signal) => registry.execute(name, args, signal),
      signal: controller.signal,
      onChunk: (chunk) => {
        mainWindow.webContents.send('agent:chunk', threadId, chunk)
        if (chunk.type === 'done' && hasLastUsage(provider)) {
          const u = provider.lastUsage
          if (u) {
            inputTokens = u.inputTokens
            outputTokens = u.outputTokens
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
    abortMap.delete(threadId)
  }

  // Surface token usage to the renderer so the per-thread cost can be shown.
  if (inputTokens || outputTokens) {
    mainWindow.webContents.send('agent:usage', threadId, { inputTokens, outputTokens })
  }

  // Return non-system messages for history persistence in main process
  const updatedHistory = messages.filter((m) => m.role !== 'system')
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
  const base = (url || DEFAULT_LM_STUDIO_URL).replace(/\/$/, '')
  // Prefer the key the user just typed (unsaved), else the stored one.
  const key = (apiKey && apiKey.trim()) || lmStudioKey()
  try {
    const res = await fetch(`${base}/models`, {
      signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
    const json = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id)
    return { ok: true, models }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
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
  if (s.includes('context_length') || s.includes('context window'))
    return 'Conversation too long. Starting a new thread is recommended.'
  return `An error occurred: ${err instanceof Error ? err.message : s}`
}
