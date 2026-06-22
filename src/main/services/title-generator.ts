import { createLMStudioProvider } from '@shared/llm/create-provider.ts'
import type { LLMMessage, LLMProvider } from '@shared/types'
import { LM_STUDIO_MODEL_IDS, DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { getSetting, getLmStudioApiKey } from './settings.ts'
import { DEFAULT_LM_STUDIO_URL, buildProvider, fetchFirstLocalModel } from './provider-selection.ts'

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
