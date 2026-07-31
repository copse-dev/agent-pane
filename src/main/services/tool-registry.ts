import { z } from 'zod'
import type { ToolDefinition, LLMTool, ToolExecuteResult } from '@shared/types'
import { normalizeToolExecuteResult, type ToolResultImage } from '@shared/types'
import {
  getReadonlyToolBlockReason,
  isToolAllowedInReadonlyMode,
} from '@shared/tools/readonly-tools.ts'
import type { PermissionCheck } from './security/permission-policy.ts'
import { isAgentRunReadonly } from './agent-run-readonly.ts'
import { getMcpToolMeta } from './mcp/mcp-registry.ts'
import { expectRecord } from '@shared/unknown-value.ts'
import { getThreadExecutionContext } from './thread-execution-context.ts'
import { isActiveSshWorkspace } from './ssh-workspace/execution-target.ts'
import { ensureExecutionRootWatched } from './search/execution-root-watcher.ts'
import {
  CACHEABLE_TOOLS,
  getCachedToolResult,
  invalidateThreadToolCache,
  setCachedToolResult,
  type ToolCacheIdentity,
} from './search/tool-result-cache.ts'

type PermissionGateFn = (check: PermissionCheck) => Promise<boolean>

interface RegisteredTool {
  name: string
  description: string
  parameters: z.ZodType
  rawParameters?: Record<string, unknown>
  parse: (rawArgs: unknown) => unknown
  execute: (args: unknown, signal: AbortSignal) => ToolExecuteResult | Promise<ToolExecuteResult>
}

let permissionGateOverride: PermissionGateFn | null = null
let permissionGateDefault: PermissionGateFn | null = null

async function ensurePermitted(check: PermissionCheck): Promise<boolean> {
  if (permissionGateOverride) return permissionGateOverride(check)
  if (!permissionGateDefault) {
    const mod = await import('./security/permission-gate.ts')
    permissionGateDefault = mod.ensureToolPermitted
  }
  return permissionGateDefault(check)
}

/** Test hook — bypasses the real permission gate (and its Electron deps). */
export function setPermissionGateForTests(fn: PermissionGateFn | null): void {
  permissionGateOverride = fn
}

/**
 * Append a hook's current-turn injected context (H2) to a tool result, keeping
 * the result's structured shape (edit stats) intact. A blank line separates the
 * tool output from the injected system-reminder block.
 */
function appendInjectedContext(result: ToolExecuteResult, block: string): ToolExecuteResult {
  if (typeof result === 'string') return `${result}\n\n${block}`
  return { ...result, result: `${result.result}\n\n${block}` }
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  register<TArgs>(tool: ToolDefinition<TArgs>): void {
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.rawParameters ? { rawParameters: tool.rawParameters } : {}),
      parse: (rawArgs) => tool.parameters.parse(rawArgs),
      execute: (args, signal) => tool.execute(tool.parameters.parse(args), signal),
    })
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  toLLMTools(): LLMTool[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters:
        t.rawParameters ??
        (z.toJSONSchema(t.parameters, { target: 'openapi-3.0' }) as Record<string, unknown>),
    }))
  }

  /**
   * Tools in MCP shape with **draft 2020-12** input schemas. The Anthropic API
   * validates MCP tool schemas against 2020-12 and rejects the openapi-3.0
   * flavor {@link toLLMTools} emits (`nullable`, boolean `exclusiveMinimum`) —
   * an external agent that mounts such a tool dies with a 400 on its next
   * model call. Tools whose zod schema can't convert are omitted (with a
   * warning) rather than poisoning the whole toolset.
   */
  toMcpTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    const tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = []
    for (const t of this.tools.values()) {
      try {
        tools.push({
          name: t.name,
          description: t.description,
          inputSchema: t.rawParameters ?? z.toJSONSchema(t.parameters),
        })
      } catch (err) {
        console.warn(
          `[tools] Skipping "${t.name}" from MCP export — schema conversion failed:`,
          err,
        )
      }
    }
    return tools
  }

  /** Validate/coerce recovered text-tool-call args; returns null when unknown or invalid. */
  tryCoerceArgs(name: string, rawArgs: unknown): Record<string, unknown> | null {
    const tool = this.tools.get(name)
    if (!tool) return null
    const parsed = tool.parameters.safeParse(rawArgs)
    if (!parsed.success) return null
    return expectRecord(parsed.data)
  }

  async execute(name: string, rawArgs: unknown, signal: AbortSignal): Promise<ToolExecuteResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const parsed = tool.parse(rawArgs)
    const mcpAnnotations = name.startsWith('mcp__') ? getMcpToolMeta(name)?.annotations : undefined
    if (isAgentRunReadonly()) {
      const blockReason = getReadonlyToolBlockReason(name, { mcpAnnotations })
      if (blockReason) return blockReason
    }
    // The check is passed by reference so the gate can stamp back a hook's
    // current-turn injected context (H2) — read off the same object after.
    const check: PermissionCheck = { toolName: name, args: parsed }
    const permitted = await ensurePermitted(check)
    if (!permitted) return `User rejected the ${name} tool call.`

    // Search caching is scoped to a thread's fixed execution root, so it needs
    // the trusted per-turn context — never the renderer-selected workspace.
    // Outside an agent turn (plain IPC, tests) there is no thread to key on and
    // nothing is cached.
    const context = getThreadExecutionContext()
    const identity: ToolCacheIdentity | null = context
      ? { threadId: context.threadId, root: context.root, branch: context.branch }
      : null
    const cacheable = identity !== null && CACHEABLE_TOOLS.has(name)
    const cached = cacheable ? getCachedToolResult(identity, name, parsed) : undefined
    let result: ToolExecuteResult
    if (cached !== undefined) {
      result = cached
    } else {
      result = await tool.execute(rawArgs, signal)
      if (identity && !isToolAllowedInReadonlyMode(name, { mcpAnnotations })) {
        // A tool that can mutate the workspace ran — this thread's cached
        // results may now be stale.
        invalidateThreadToolCache(identity.threadId)
      } else if (
        // Only cache what we can invalidate. SSH workspaces have no local
        // fs.watch, and a root we failed to watch would be stuck serving stale
        // results for the rest of the thread.
        cacheable &&
        !isActiveSshWorkspace() &&
        ensureExecutionRootWatched(identity.root)
      ) {
        setCachedToolResult(identity, name, parsed, result)
      }
    }
    // H2: a `toolGate` hook injected context into the current turn. Append the
    // pre-built system-reminder block (10k-capped) to this call's textual
    // result so the model reads it right after the tool output.
    if (check.injectContext !== undefined && check.injectContext.length > 0) {
      return appendInjectedContext(result, check.injectContext)
    }
    return result
  }

  /** Execute and unwrap structured tool results (e.g. file-edit line stats). */
  async executeNormalized(
    name: string,
    rawArgs: unknown,
    signal: AbortSignal,
  ): Promise<{
    result: string
    editStats?: { additions: number; deletions: number }
    resultFormat?: 'markdown'
    /**
     * Images a tool produced alongside its text (video_frames). Always returned
     * by `normalizeToolExecuteResult`; declared here so callers that can render
     * them — the ACP native-tool bridge — are not silently handed text only.
     */
    images?: ToolResultImage[]
  }> {
    return normalizeToolExecuteResult(await this.execute(name, rawArgs, signal))
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  names(): string[] {
    return Array.from(this.tools.keys())
  }
}
