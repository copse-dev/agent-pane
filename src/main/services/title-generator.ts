import {
  resolveSmallTasksProvider,
  resolveSmallTasksModelId,
} from './providers/small-tasks-provider.ts'
import { completeTextWithUsage } from './providers/llm-complete-text.ts'
import { recordUsageEvent } from './storage/usage-ledger.ts'

// Trim model output down to a single clean title line.
function cleanTitle(out: string): string | null {
  const firstLine = out.trim().split('\n')[0] ?? ''
  const title = firstLine.replace(/^["'#\s-]+|["'.\s]+$/g, '').slice(0, 60)
  return title || null
}

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

// Generate a short thread title from the first user message. Uses the
// configured small-tasks model; returns null on failure so the caller can
// fall back to a heuristic.
export async function suggestThreadTitle(text: string): Promise<string | null> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) return null
  const model = resolveSmallTasksModelId()

  const prompt =
    'Reply with ONLY a concise 3-5 word title in Title Case for the following request. ' +
    'No quotes, no trailing punctuation.\n\nRequest:\n' +
    text.slice(0, 500)
  try {
    const { text: out, usage } = await completeTextWithUsage(provider, prompt, 20_000)
    recordSmallTasksUsage(model, usage)
    return cleanTitle(out)
  } catch {
    return null
  }
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
    return cleanTitle(out)
  } catch {
    return null
  }
}
