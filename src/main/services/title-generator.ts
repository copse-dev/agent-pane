import type { LLMMessage, LLMProvider } from '@shared/types'
import { resolveSmallTasksProvider } from './small-tasks-provider.ts'

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

// Trim model output down to a single clean title line.
function cleanTitle(out: string): string | null {
  const title = out
    .trim()
    .split('\n')[0]!
    .replace(/^["'#\s-]+|["'.\s]+$/g, '')
    .slice(0, 60)
  return title || null
}

// Generate a short thread title from the first user message. Uses the
// configured small-tasks model; returns null on failure so the caller can
// fall back to a heuristic.
export async function suggestThreadTitle(text: string): Promise<string | null> {
  const provider = await resolveSmallTasksProvider()
  if (!provider) return null

  const prompt =
    'Reply with ONLY a concise 3-5 word title in Title Case for the following request. ' +
    'No quotes, no trailing punctuation.\n\nRequest:\n' +
    text.slice(0, 500)
  try {
    return cleanTitle(await completeText(provider, prompt))
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

  const prompt =
    'Reply with ONLY a concise 2-4 word label in Title Case describing what this ' +
    'terminal session is doing, based on its recent output (e.g. "Running Tests", ' +
    '"Git Status", "Dev Server"). No quotes, no trailing punctuation.\n\nTerminal output:\n' +
    text.slice(-1500)
  try {
    return cleanTitle(await completeText(provider, prompt))
  } catch {
    return null
  }
}
