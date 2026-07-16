import type { LLMTool } from '@shared/types'
import type { HashFn } from './spine-schema.ts'

/**
 * Content-addressed fingerprint of the toolset offered to the model (decision 6
 * of docs/plans/hooks-and-feature-packs.md). The blob body lists the sorted
 * tool names with a per-tool schema hash; its own hash is what spine lines
 * reference. Toolsets change rarely (pack toggle, MCP connect, readonly mode),
 * so the dedupe makes storing one per LLM call near-free while supporting
 * "prove tool X was offered at call time" debugging and eval reproducibility.
 *
 * Pure module (no `node:*`/Electron): the hash function is injected, same as
 * the rest of the spine machinery, so fingerprints are unit-testable anywhere.
 */

export interface ToolsetFingerprint {
  /** Hex hash of {@link ToolsetFingerprint.contents} — the reference spine lines store. */
  hash: string
  /** Canonical JSON blob body (deterministic key and tool ordering). */
  contents: string
}

/** JSON.stringify with object keys sorted recursively, for a canonical encoding. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

/** Fingerprint a toolset: sorted tool names, each with a hash of its schema. */
export function fingerprintToolset(tools: readonly LLMTool[], hash: HashFn): ToolsetFingerprint {
  const entries = tools
    .map((tool) => ({
      name: tool.name,
      schemaHash: hash(
        stableStringify({ description: tool.description, parameters: tool.parameters }),
      ),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const contents = `${JSON.stringify({ v: 1, tools: entries }, null, 2)}\n`
  return { hash: hash(contents), contents }
}
