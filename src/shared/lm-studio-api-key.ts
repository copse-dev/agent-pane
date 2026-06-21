/** Resolve LM Studio bearer token: Settings store, then shell env, then LM Studio no-auth default. */
export function resolveLmStudioApiKey(
  storedKey: string | null | undefined,
  env: { LM_STUDIO_API_KEY?: string; LM_API_TOKEN?: string },
): string {
  const stored = storedKey?.trim()
  if (stored) return stored
  const fromEnv = env.LM_STUDIO_API_KEY?.trim() || env.LM_API_TOKEN?.trim()
  if (fromEnv) return fromEnv
  return 'lm-studio'
}
