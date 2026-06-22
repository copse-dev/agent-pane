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
