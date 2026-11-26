/**
 * `run_code` (experimental code mode): run a TypeScript cell in this thread's
 * code-cell container and return what it printed and returned. A cell reaches
 * the thread's files only through read-only Copse tools, so it can combine,
 * filter or count several tool results without each one entering the model's
 * context. See `../services/code-mode/`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { defineTool, type ToolDefinition, type ToolExecuteResult } from '@shared/types'
import { wrapExternalContent } from '@copse/agent/external-content.ts'
import { errorMessage } from '@shared/errors.ts'
import { truncateToolOutput } from '../services/exec/subprocess-output-cap.ts'
import { getThreadExecutionContext } from '../services/thread-execution-context.ts'
import type { CellOutcome } from '../services/code-mode/code-cell-container.ts'
import type { CodeCellPool } from '../services/code-mode/code-cell-pool.ts'
import {
  CellToolSession,
  CODE_CELL_MAX_TOOL_CALLS,
  CODE_CELL_TOOLS,
  type CellToolHost,
} from '../services/code-mode/code-cell-tools.ts'
import {
  CODE_CELL_MAX_TIMEOUT_MS,
  CODE_CELL_SOURCE_LIMIT,
} from '../services/code-mode/code-cell-wire.ts'
import { codeModeEnabled, getCodeCellPool } from '../services/code-mode/code-mode-service.ts'

export const RUN_CODE_TOOL_NAME = 'run_code'
const DEFAULT_TIMEOUT_SECONDS = 60
/** What the model reads of one cell, in bytes, as for a shell command. */
const RUN_CODE_OUTPUT_MAX_BYTES = 100 * 1024

const DESCRIPTION = [
  "Run a TypeScript cell in this thread's code container and return its console output and return value.",
  'Inside the cell, `await tools.<name>(args)` calls a read-only Copse tool with the same arguments as that tool and resolves to its text result, which is the refusal text when the call is blocked or denied; a call with bad arguments or an unavailable tool throws.',
  `Callable: ${CODE_CELL_TOOLS.join(', ')}. At most ${String(CODE_CELL_MAX_TOOL_CALLS)} calls per cell.`,
  'Use it to combine, filter or count several tool results in one step instead of reading each into the conversation.',
  "The cell is the body of an async function: use `await` and `return`. Values put on `state` (or globalThis) stay for this thread's later cells; `const` and `let` do not.",
  'No imports, require, process, network or filesystem. A cell that times out, or a stopped turn, discards the container and its state.',
].join(' ')

const parameters = z.object({
  code: z
    .string()
    .min(1)
    .max(CODE_CELL_SOURCE_LIMIT)
    .describe('TypeScript: the body of an async function. Use `return` for the result.'),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(CODE_CELL_MAX_TIMEOUT_MS / 1000)
    .optional()
    .describe(`Seconds before the cell is stopped. Default ${String(DEFAULT_TIMEOUT_SECONDS)}.`),
})

const DISCARDED =
  "The thread's code container was discarded, so values saved on `state` are gone; the next cell starts fresh."

/** The text the model reads for one cell's outcome. */
export function formatCellOutcome(outcome: CellOutcome, session: CellToolSession): string {
  const notes: string[] = []
  if (session.calls > 0)
    notes.push(`${String(session.calls)} tool call${session.calls === 1 ? '' : 's'}`)
  if (session.imagesDropped > 0) {
    notes.push(
      `${String(session.imagesDropped)} image${session.imagesDropped === 1 ? '' : 's'} from tool results not passed to the cell`,
    )
  }
  switch (outcome.kind) {
    case 'timeout':
      return `The cell did not finish in time and was stopped. ${DISCARDED}`
    case 'aborted':
      return `The cell was cancelled. ${DISCARDED}`
    case 'failed':
      return `The code container failed: ${outcome.error}\n${DISCARDED}`
    case 'result': {
      const { result } = outcome
      const parts: string[] = []
      if (result.logs.length > 0) parts.push(`Console:\n${result.logs.trimEnd()}`)
      if (result.ok) {
        parts.push(result.value.length > 0 ? `Returned:\n${result.value}` : 'Returned nothing.')
      } else {
        parts.push(`The cell threw:\n${result.error}`)
      }
      if (result.truncated)
        parts.push('(The cell produced more output than a cell may return; the rest was dropped.)')
      if (notes.length > 0) parts.push(`(${notes.join('; ')})`)
      return parts.join('\n\n')
    }
  }
}

export function createRunCodeTool(
  registry: CellToolHost,
  pool: () => CodeCellPool = getCodeCellPool,
): ToolDefinition<z.infer<typeof parameters>> {
  return defineTool({
    name: RUN_CODE_TOOL_NAME,
    description: DESCRIPTION,
    parameters,
    async execute({ code, timeout_seconds }, signal): Promise<ToolExecuteResult> {
      if (!codeModeEnabled()) return 'Code mode is off. Turn it on in Settings → Experimental.'
      const context = getThreadExecutionContext()
      if (context === null) return 'run_code runs only inside a thread.'
      const cells = pool()
      // The tool ran, so the setting is on: a host that never ran the
      // start-up sync (a headless one) starts its pool here.
      cells.enable()
      const session = new CellToolSession(registry, AsyncLocalStorage.snapshot())
      let outcome: CellOutcome
      try {
        outcome = await cells.run(
          { projectId: context.projectId, threadId: context.threadId },
          {
            code,
            timeoutMs: (timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
            signal,
            callTool: session.handle,
          },
        )
      } catch (error) {
        return `Could not start a code container: ${errorMessage(error)}`
      }
      const text = truncateToolOutput(
        formatCellOutcome(outcome, session),
        RUN_CODE_OUTPUT_MAX_BYTES,
      )
      const framed = session.external ? wrapExternalContent(RUN_CODE_TOOL_NAME, text) : text
      const omitted =
        session.remindersOmitted > 0
          ? [
              `(${String(session.remindersOmitted)} more note${session.remindersOmitted === 1 ? '' : 's'} from the cell's tool calls left out)`,
            ]
          : []
      return [framed, ...session.reminders, ...omitted].join('\n\n')
    },
  })
}
