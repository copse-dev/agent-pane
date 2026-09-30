import { createHash, randomUUID } from 'node:crypto'
import type { ModelUsage } from './wire-types.ts'

interface PrefixHashes {
  systemHash: string
  toolsHash: string
  /** Short per-item hashes of the request's conversation, when the caller supplies it. */
  itemHashes: string[]
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

  /**
   * `items` is the request's whole ordered conversation (Responses `input`).
   * With it, the report also says where the previous request's conversation
   * first stopped being a prefix of this one — the index a cache miss starts at.
   */
  begin(
    system: unknown,
    tools: unknown,
    items: readonly unknown[] = [],
  ): (usage: ModelUsage | null) => void {
    if (process.env['COPSE_DEBUG_PROMPT_CACHE'] !== '1') return () => {}
    const scopeHash = hash([this.transport, this.model, this.endpoint, this.cacheKey])
    const hashes = {
      systemHash: hash(system),
      toolsHash: hash(tools),
      itemHashes: items.map((item) => hash(item).slice(0, 8)),
    }
    const previous = previousPrefixes.get(scopeHash)
    previousPrefixes.delete(scopeHash)
    previousPrefixes.set(scopeHash, hashes)
    if (previousPrefixes.size > MAX_SCOPES) {
      const oldest = previousPrefixes.keys().next().value
      if (oldest !== undefined) previousPrefixes.delete(oldest)
    }
    const changedAt = previous
      ? previous.itemHashes.findIndex((itemHash, index) => hashes.itemHashes[index] !== itemHash)
      : -1
    const request = {
      transport: this.transport,
      model: this.model,
      requestId: randomUUID(),
      scopeHash,
      systemHash: hashes.systemHash,
      toolsHash: hashes.toolsHash,
      inputItems: hashes.itemHashes.length,
      // Null: nothing to compare. -1: every earlier item was reproduced.
      firstChangedInputIndex: previous && items.length > 0 ? changedAt : null,
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
