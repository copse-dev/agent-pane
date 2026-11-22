/**
 * The host's answer to a cell's `await tools.<name>(args)`.
 *
 * A cell may call a fixed set of read-only tools. Each call goes through
 * `ToolRegistry.execute` inside the async context of the `run_code` call that
 * started the cell: the permission gate, tool-gate hooks, read-only mode, plan
 * blocks, the thread's execution root and deferred-checkout handling all apply
 * to it, and an external result still marks the turn. Nothing a cell asks for
 * runs with more authority than the same call from the model would have.
 *
 * What the agent loop adds around a direct call does not happen for a nested
 * one: `afterToolUse` hooks, nested instruction discovery for the paths read,
 * and skill activation. A refusal the registry returns as text (a blocked
 * tool, a denied approval) reaches the cell as that text, as it would reach
 * the model.
 *
 * Two things the model would otherwise lose are kept for it: any
 * system-reminder blocks the registry appended to a nested result (a hook's
 * injected context, a clamp note) are lifted out and returned after the cell's
 * output, and the cell's output is marked external when any result it saw was.
 */
import type { ToolProvenance } from '@shared/types'
import { errorMessage } from '@shared/errors.ts'
import { truncateToolOutput } from '../exec/subprocess-output-cap.ts'
import type { CellToolHandler } from './code-cell-container.ts'
import type { ToolCallResponse } from './code-cell-wire.ts'

/**
 * What a cell may call: reads of the thread's checkout, search and Git
 * inspection. Every entry is also in `READONLY_AGENT_TOOLS`
 * (`code-cell-tools.test.ts` holds that). Subagents, questions to the user,
 * plan updates and image-producing tools are left out: they are not data a
 * cell can combine. So is `read_skill`, which needs the agent loop's skill
 * activation around the call, and a nested call has none.
 */
export const CODE_CELL_TOOLS: readonly string[] = [
  'read_file',
  'list_dir',
  'search_code',
  'find_files',
  'search_codebase',
  'semantic_search',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'staged_diffs',
  'read_staged_diff',
]

/** The most tool calls one cell may make. */
export const CODE_CELL_MAX_TOOL_CALLS = 100
/** The most text one nested result hands back to the cell, in bytes. */
export const CODE_CELL_TOOL_RESULT_LIMIT = 2 * 1024 * 1024

/** The part of the tool registry a cell's calls need. */
export interface CellToolHost {
  has(name: string): boolean
  provenanceOf(name: string): ToolProvenance | undefined
  executeNormalized(
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<{ result: string; appendedReminderLengths?: number[]; images?: unknown[] }>
}

/** Runs a function in the async context of the turn that started the cell. */
export type InTurn = <R>(fn: () => R) => R

/**
 * Split the system-reminder blocks the registry appended (each preceded by a
 * blank line, lengths in `appendedReminderLengths`) off a result.
 */
export function splitAppendedReminders(
  result: string,
  lengths: readonly number[] | undefined,
): { body: string; reminders: string[] } {
  if (lengths === undefined || lengths.length === 0) return { body: result, reminders: [] }
  const total = lengths.reduce((sum, length) => sum + length + 2, 0)
  if (total > result.length) return { body: result, reminders: [] }
  const reminders: string[] = []
  let offset = result.length - total
  for (const length of lengths) {
    reminders.push(result.slice(offset + 2, offset + 2 + length))
    offset += length + 2
  }
  return { body: result.slice(0, result.length - total), reminders }
}

export class CellToolSession {
  private readonly host: CellToolHost
  private readonly inTurn: InTurn
  /** How many tool calls the cell made. */
  calls = 0
  /** Whether any result the cell saw came from outside the workspace. */
  external = false
  /** System-reminder blocks lifted off nested results, for the model. */
  readonly reminders: string[] = []
  /** How many images nested results carried that a cell cannot receive. */
  imagesDropped = 0

  constructor(host: CellToolHost, inTurn: InTurn) {
    this.host = host
    this.inTurn = inTurn
  }

  private available(): string[] {
    return CODE_CELL_TOOLS.filter((name) => this.host.has(name))
  }

  readonly handle: CellToolHandler = async (name, args, signal): Promise<ToolCallResponse> => {
    const available = this.available()
    if (!available.includes(name)) {
      return {
        ok: false,
        error: `tools.${name} is not available in a code cell. Available: ${available.join(', ')}.`,
      }
    }
    if (this.calls >= CODE_CELL_MAX_TOOL_CALLS) {
      return {
        ok: false,
        error: `A cell may make at most ${String(CODE_CELL_MAX_TOOL_CALLS)} tool calls.`,
      }
    }
    this.calls += 1
    if (this.host.provenanceOf(name) === 'external') this.external = true
    try {
      const outcome = await this.inTurn(() => this.host.executeNormalized(name, args, signal))
      const { body, reminders } = splitAppendedReminders(
        outcome.result,
        outcome.appendedReminderLengths,
      )
      this.reminders.push(...reminders)
      this.imagesDropped += outcome.images?.length ?? 0
      return { ok: true, result: truncateToolOutput(body, CODE_CELL_TOOL_RESULT_LIMIT) }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }
}
