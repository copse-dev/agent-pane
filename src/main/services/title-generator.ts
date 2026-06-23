import { resolveSmallTasksProvider, resolveSmallTasksModelId } from './small-tasks-provider.ts'
import { completeTextWithUsage } from './llm-complete-text.ts'
import { recordUsageEvent } from './usage-ledger.ts'

// Trim model output down to a single clean title line.
function cleanTitle(out: string): string | null {
  const title = out
    .trim()
    .split('\n')[0]!
    .replace(/^["'#\s-]+|["'.\s]+$/g, '')
    .slice(0, 60)
  return title || null
}

async function recordSmallTasksUsage(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
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
    await recordSmallTasksUsage(model, usage)
    return cleanTitle(out)
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
    await recordSmallTasksUsage(model, usage)
    return cleanTitle(out)
  } catch {
    return null
  }
}
