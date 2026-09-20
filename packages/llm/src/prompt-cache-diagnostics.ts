import { createHash, randomUUID } from 'node:crypto'
import type { ModelUsage } from './wire-types.ts'

interface PrefixHashes {
  systemHash: string
  toolsHash: string
}

// Providers are rebuilt between user turns. Retain only hashes, bounded across
// those instances, so a thread can compare requests without retaining prompts.
const previousPrefixes = new Map<string, PrefixHashes>()
const MAX_SCOPES = 128

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
}

/** Opt-in request diagnostics; never logs prompt text, tool schemas, endpoints or keys. */
export class PromptCacheDiagnostics {
  private readonly transport: string
  private readonly model: string
  private readonly endpoint: string
  private readonly cacheKey: string

  constructor(transport: string, model: string, endpoint: string, cacheKey?: string) {
    this.transport = transport
    this.model = model
    this.endpoint = endpoint
    // Without a thread key, only compare this provider instance's requests.
    this.cacheKey = cacheKey ?? randomUUID()
  }

  begin(system: unknown, tools: unknown): (usage: ModelUsage | null) => void {
    if (process.env['COPSE_DEBUG_PROMPT_CACHE'] !== '1') return () => {}
    const scopeHash = hash([this.transport, this.model, this.endpoint, this.cacheKey])
    const hashes = { systemHash: hash(system), toolsHash: hash(tools) }
    const previous = previousPrefixes.get(scopeHash)
    previousPrefixes.delete(scopeHash)
    previousPrefixes.set(scopeHash, hashes)
    if (previousPrefixes.size > MAX_SCOPES) {
      const oldest = previousPrefixes.keys().next().value
      if (oldest !== undefined) previousPrefixes.delete(oldest)
    }
    const request = {
      transport: this.transport,
      model: this.model,
      requestId: randomUUID(),
      scopeHash,
      ...hashes,
      systemChanged: previous ? previous.systemHash !== hashes.systemHash : null,
      toolsChanged: previous ? previous.toolsHash !== hashes.toolsHash : null,
    }
    // Capture metadata at request start, not stream completion: interleaved
    // streams must not compare against each other's later state.
    return (usage) => {
      console.error(
        '[prompt-cache]',
        JSON.stringify({
          ...request,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          cacheReadTokens: usage?.cacheReadTokens ?? null,
          cacheCreationTokens: usage?.cacheCreationTokens ?? null,
        }),
      )
    }
  }
}
