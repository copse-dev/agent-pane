import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { sanitizeMcpInputSchema, flattenMcpContent } from './mcp-schema.ts'

/**
 * Pure (no Electron / fs) normalization for user-defined "custom tools".
 *
 * A custom tool is an in-process function the user drops into their trusted
 * tools directory — the same ergonomics as Cursor's SDK `local.customTools`,
 * minus standing up a whole MCP server for a single function. The module's
 * default export is a plain object (or an array of them, or a factory returning
 * either):
 *
 *   export default {
 *     name: 'lookup_user',
 *     description: 'Look up a user by id',
 *     inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
 *     async execute({ id }, signal) { return await db.users.find(id) },
 *   }
 *
 * These run with full Node privilege in the main process, so they are loaded
 * ONLY from a user-trusted directory — never from the (attacker-controlled)
 * workspace. See custom-tools-registry.ts for the loader and trust boundary.
 */

/** Tool-name prefix that namespaces custom tools in the registry (cf. `mcp__`). */
export const CUSTOM_TOOL_PREFIX = 'custom__'

const BASE_NAME_RE = /^[A-Za-z0-9_]+$/

export function customToolName(name: string): string {
  return `${CUSTOM_TOOL_PREFIX}${name}`
}

/** Human label for an already-prefixed custom tool name. */
export function customToolLabel(toolName: string): string {
  return toolName.startsWith(CUSTOM_TOOL_PREFIX)
    ? toolName.slice(CUSTOM_TOOL_PREFIX.length)
    : toolName
}

export interface RawCustomTool {
  name?: unknown
  description?: unknown
  /** JSON Schema for the arguments; `parameters` is accepted as an alias. */
  inputSchema?: unknown
  parameters?: unknown
  /** Force an approval prompt even if the user remembered this tool. */
  requiresApproval?: unknown
  execute?: unknown
}

type RawExecute = (args: unknown, signal: AbortSignal) => unknown

interface CustomEnvelope {
  content?: unknown
  isError?: unknown
}

/**
 * Coerce a custom tool's return value into the single string the agent loop
 * expects. Accepts a plain string, a JSON value, or an MCP-style envelope
 * (`{ content: [...], isError }`) — the last reusing the MCP content flattener
 * so an existing tool body can be reused verbatim.
 */
function coerceResult(out: unknown): string {
  if (out == null) return ''
  if (typeof out === 'string') return out
  if (typeof out === 'number' || typeof out === 'boolean' || typeof out === 'bigint') {
    return String(out)
  }
  if (typeof out === 'object') {
    const env = out as CustomEnvelope
    if (Array.isArray(env.content)) {
      const text = flattenMcpContent(env.content)
      if (env.isError) throw new Error(text || 'Custom tool reported an error')
      return text
    }
    try {
      return JSON.stringify(out) ?? ''
    } catch {
      return '[unserializable custom tool result]'
    }
  }
  // symbol / function are not meaningful tool output
  return ''
}

/**
 * Validate and wrap a raw custom-tool definition into a `ToolDefinition`.
 * Returns `{ error }` (and no tool) for malformed entries so the loader can
 * surface the problem instead of silently dropping it.
 */
export function normalizeCustomTool(
  raw: RawCustomTool,
  source?: string,
): { tool?: ToolDefinition; error?: string } {
  const where = source ? ` (${source})` : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) {
    return { error: `Custom tool with a missing or empty "name" was ignored${where}.` }
  }
  if (!BASE_NAME_RE.test(name)) {
    return {
      error: `Custom tool "${name}" has an invalid name${where}; use only letters, digits, and underscores.`,
    }
  }
  if (typeof raw.execute !== 'function') {
    return { error: `Custom tool "${name}" is missing an "execute" function${where}.` }
  }

  const userExecute = raw.execute as RawExecute
  const description = typeof raw.description === 'string' ? raw.description : ''
  // Sanitize like an MCP schema: guarantees the `{ type: 'object', properties }`
  // shape providers expect and bounds depth/size even for hand-written schemas.
  const rawParameters = sanitizeMcpInputSchema(raw.inputSchema ?? raw.parameters)

  const tool: ToolDefinition = {
    name: customToolName(name),
    description: `[custom] ${description}`.trim(),
    parameters: z.unknown(),
    rawParameters,
    ...(raw.requiresApproval === true ? { requiresApproval: true } : {}),
    async execute(args, signal) {
      const out = await userExecute((args ?? {}), signal)
      return coerceResult(out)
    },
  }
  return { tool }
}
