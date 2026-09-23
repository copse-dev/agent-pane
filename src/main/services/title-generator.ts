import { mockScenarioTitle } from '@copse/llm/mock-script.ts'
import {
  resolveSmallTasksFallbackRoute,
  resolveSmallTasksModelId,
  resolveSmallTasksProvider,
  resolveSmallTasksRoute,
  type SmallTasksRoute,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'
import { cleanThreadTitle, threadTitlePrompt } from '@shared/thread-title.ts'

export { threadTitlePrompt } from '@shared/thread-title.ts'

function recordSmallTasksUsage(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): void {
  if (!usage.inputTokens && !usage.outputTokens) return
  recordUsageEvent({
    model,
    source: 'small-tasks',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  })
}

async function* threadTitleRoutes(): AsyncIterable<SmallTasksRoute> {
  const primary = await resolveSmallTasksRoute()
  if (!primary) return
  yield primary

  // An async generator stays paused after the primary yield, so the chat route
  // is resolved only after the local/configured model actually fails.
  const fallback = await resolveSmallTasksFallbackRoute(primary.model)
  if (fallback) yield fallback
}

export interface ThreadTitleCompletion {
  title: string
  model: string
  usage: { inputTokens: number; outputTokens: number }
}

/** Try title routes in order, including malformed-output failover. */
export async function completeThreadTitleWithRoutes(
  text: string,
  routes: AsyncIterable<SmallTasksRoute>,
): Promise<ThreadTitleCompletion | null> {
  const prompt = threadTitlePrompt(text)
  for await (const route of routes) {
    try {
      const { text: output, usage } = await completeTextWithUsage(route.provider, prompt, 20_000)
      const title = cleanThreadTitle(output)
      if (title) return { title, model: route.model, usage }
    } catch {
      // The selected local model may build successfully while its server is
      // stopped or that model is unloaded. Advance to the chat route.
    }
  }
  return null
}

// Generate a short thread title from the user's side of the thread — the first
// message alone on a new thread, or the opening plus recent messages when the
// caller is re-titling a thread that has moved on. Uses the configured
// small-tasks model, then the chat model if inference fails; returns null when
// neither route can produce a valid title.
export async function suggestThreadTitle(text: string): Promise<string | null> {
  if (__COPSE_TEST_SCENARIOS__ && process.env['COPSE_PANEL_MOCK_LLM'] === '1') {
    return mockScenarioTitle(text)
  }
  const completion = await completeThreadTitleWithRoutes(text, threadTitleRoutes())
  if (!completion) return null
  recordSmallTasksUsage(completion.model, completion.usage)
  return completion.title
}

// Trim model output to a single clean phrase (sentence case left as-is).
function cleanPhrase(out: string, max = 64): string | null {
  const firstLine = out.trim().split('\n')[0] ?? ''
  const phrase = firstLine.replace(/^["'#\s-]+|["'.\s]+$/g, '').slice(0, max)
  return phrase || null
}

// Summarize a batch of shell commands that ran together in one step into a
// short phrase (e.g. "Run tests and inspect the diff"). Kicked off while the
// commands execute so the rolled-up label is ready by the time they finish.
// Uses the configured small-tasks model; returns null on failure or when fewer
// than two commands are supplied (nothing to roll up).
export async function suggestCommandSummary(commands: string[]): Promise<string | null> {
  if (!Array.isArray(commands) || commands.length < 2) return null
  const provider = await resolveSmallTasksProvider()
  if (!provider) return null
  const model = resolveSmallTasksModelId()

  const list = commands
    .slice(0, 12)
    .map((c, i) => `${String(i + 1)}. ${c}`)
    .join('\n')
    .slice(0, 1500)
  const prompt =
    'These shell commands were run together as one step. Reply with ONLY a concise ' +
    '3-6 word description in sentence case of what they collectively accomplish ' +
    '(e.g. "Run tests and inspect the diff"). No quotes, no trailing punctuation.\n\n' +
    'Commands:\n' +
    list
  try {
    const { text, usage } = await completeTextWithUsage(provider, prompt, 20_000)
    recordSmallTasksUsage(model, usage)
    return cleanPhrase(text)
  } catch {
    return null
  }
}

/**
 * Polish a turn's canned tool rollup (`Used 12 tools` / `Read files`) into a
 * short past-tense phrase. Non-blocking caller: returns null when the
 * small-tasks model is unavailable or fewer than two actions are supplied.
 */
export async function suggestToolTurnSummary(actions: string[]): Promise<string | null> {
  if (!Array.isArray(actions) || actions.length < 2) return null
  const provider = await resolveSmallTasksProvider()
  if (!provider) return null
  const model = resolveSmallTasksModelId()

  const list = actions
    .slice(0, 16)
    .map((a, i) => `${String(i + 1)}. ${a}`)
    .join('\n')
    .slice(0, 1500)
  const prompt =
    'An agent just finished these tool actions in one turn. Reply with ONLY a concise ' +
    '3-8 word past-tense phrase in sentence case summarizing what was done ' +
    '(e.g. "Read the settings UI" or "Searched code and ran tests"). ' +
    'No quotes, no trailing punctuation, no tool counts.\n\nActions:\n' +
    list
  try {
    const { text, usage } = await completeTextWithUsage(provider, prompt, 20_000)
    recordSmallTasksUsage(model, usage)
    return cleanPhrase(text, 72)
  } catch {
    return null
  }
}

// Generate a short label for a terminal session from its recent output. Uses
// the configured small-tasks model; returns null on failure so the caller can
// keep the default "Terminal N" label.
export async function suggestTerminalTitle(text: string): Promise<string | null> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) return null
  const model = resolveSmallTasksModelId()

  const prompt =
    'Reply with ONLY a concise 2-4 word label in Title Case describing what this ' +
    'terminal session is doing, based on its recent output (e.g. "Running Tests", ' +
    '"Git Status", "Dev Server"). No quotes, no trailing punctuation.\n\nTerminal output:\n' +
    text.slice(-1500)
  try {
    const { text: out, usage } = await completeTextWithUsage(provider, prompt, 20_000)
    recordSmallTasksUsage(model, usage)
    return cleanPhrase(out, 60)
  } catch {
    return null
  }
}
