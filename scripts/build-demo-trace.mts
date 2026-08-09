/**
 * Turn a real exported thread (JSONL from `threadToJsonl`) into a replayable
 * browser-demo trace.
 *
 * Usage:
 *   npm run demo:trace -- <export.jsonl> --id landing --label "Landing hero" \
 *     [--turn 0] [--out src/shared/demo-traces/<id>.ts]
 *
 * Export a thread from the app (thread menu → Export JSONL), point this at the
 * file, and commit the emitted module. The demo then replays what the agent
 * actually did instead of prose written to look like it.
 *
 * Two reconstructions the export forces, both visible in the output:
 *
 * - **Order within a message.** The export stores a message's prose and its
 *   tool calls as separate fields; the live stream interleaves them. Each
 *   assistant message replays as reasoning → prose → tool calls, which reads
 *   correctly for the common "explain, then act" turn and mis-orders a turn
 *   that narrated between tool calls.
 * - **Token usage.** Usage is recorded per thread, not per turn, so a usage
 *   chunk is emitted only when the export holds a single user turn.
 *
 * Results are run through `redactSecrets` and home directories are collapsed to
 * `~`; a trace is published on a public marketing page, so read the emitted
 * module before committing it.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { redactSecrets } from '@copse/llm/redact-secrets.ts'
import type { DemoTrace, DemoTraceStep } from '@shared/demo-traces.ts'
import { z } from 'zod'

/** Pause before a tool card appears — the model "deciding" to call it. */
const TOOL_CALL_DELAY_MS = 420
/** Pause a tool card spends in its running state before its result lands. */
const TOOL_RESULT_DELAY_MS = 900
/** Pause before the usage/done pair that closes the turn. */
const TURN_END_DELAY_MS = 300

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  byModel: z.record(z.string(), z.unknown()).optional(),
})

const subagentMessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string().optional(),
  reasoning: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        args: z.unknown().optional(),
        status: z.string().optional(),
        result: z.string().nullable().optional(),
      }),
    )
    .optional(),
})

const toolCallSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  args: z.unknown().optional(),
  status: z.string().optional(),
  result: z.string().nullable().optional(),
  editStats: z.object({ additions: z.number(), deletions: z.number() }).optional(),
  resultFormat: z.literal('markdown').optional(),
  kind: z.string().optional(),
  subagent: z
    .object({
      id: z.string(),
      kind: z.enum(['explore', 'investigate_ci', 'delegate']),
      prompt: z.string(),
      summary: z.string().nullable().optional(),
      model: z.string().optional(),
      messages: z.array(subagentMessageSchema).optional(),
    })
    .optional(),
})

const threadLineSchema = z.object({
  type: z.literal('thread'),
  exportVersion: z.number().optional(),
  id: z.string(),
  title: z.string().optional(),
  usage: usageSchema.optional(),
})

const messageLineSchema = z.object({
  type: z.literal('message'),
  id: z.string(),
  role: z.string(),
  content: z.string().optional(),
  reasoning: z.string().optional(),
  model: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
})

type ThreadLine = z.infer<typeof threadLineSchema>
type MessageLine = z.infer<typeof messageLineSchema>
type ToolCallLine = z.infer<typeof toolCallSchema>

const COPSE_BRIDGE_TOOL_PREFIX = 'mcp.copse.'

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

/**
 * ACP exports preserve the adapter's MCP envelope (`mcp.copse.write_file` with
 * `{server, tool, arguments}`). Demo replay drives Copse's native tool path, so
 * collapse that envelope back to the same canonical call a built-in agent
 * emits. The underlying arguments remain verbatim and still require review.
 */
function replayToolCall(call: ToolCallLine): ToolCallLine {
  if (!call.name.startsWith(COPSE_BRIDGE_TOOL_PREFIX)) return call
  const outer = recordValue(call.args)
  return {
    ...call,
    name: call.name.slice(COPSE_BRIDGE_TOOL_PREFIX.length),
    args: recordValue(outer?.['arguments']) ?? call.args,
  }
}

function bridgedWritePaths(messages: readonly MessageLine[]): Set<string> {
  const paths = new Set<string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!call.name.startsWith(COPSE_BRIDGE_TOOL_PREFIX)) continue
      const normalized = replayToolCall(call)
      if (!['write_file', 'str_replace', 'delete_file'].includes(normalized.name)) continue
      const path = recordValue(normalized.args)?.['path']
      if (typeof path === 'string') paths.add(path)
    }
  }
  return paths
}

function isRedundantWorkspaceAudit(
  call: ToolCallLine,
  bridgedWrites: ReadonlySet<string>,
): boolean {
  if (call.name !== 'workspace_edit_audit') return false
  const files = recordValue(call.args)?.['files']
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((file) => typeof file === 'string' && bridgedWrites.has(file))
  )
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return argv[index + 1]
}

/**
 * Collapse machine-specific absolute paths to `~`. Traces are published, and a
 * home directory is both noise and a name nobody meant to publish.
 */
function scrubPaths(text: string): string {
  return text
    .replace(/(?:\/Users|\/home)\/[^/\s"']+/g, '~')
    .replace(/\/(?:private\/)?(?:var\/)?tmp\/[^/\s"']+/g, '~')
}

function clean(text: string): string {
  return scrubPaths(redactSecrets(text))
}

function parseExport(path: string): { thread: ThreadLine; messages: MessageLine[] } {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
  let thread: ThreadLine | undefined
  const messages: MessageLine[] = []
  for (const [index, line] of lines.entries()) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      fail(`${path}:${String(index + 1)} is not valid JSON — is this a thread JSONL export?`)
    }
    const asThread = threadLineSchema.safeParse(record)
    if (asThread.success) {
      thread = asThread.data
      continue
    }
    const asMessage = messageLineSchema.safeParse(record)
    if (asMessage.success) messages.push(asMessage.data)
  }
  if (!thread) fail(`${path} has no \`thread\` header line — expected a thread JSONL export.`)
  return { thread, messages }
}

/** Steps for one tool call: the card appearing, then its result landing. */
function toolCallSteps(call: ToolCallLine, index: number): DemoTraceStep[] {
  const id = call.id ?? `trace-tool-${String(index)}`
  const steps: DemoTraceStep[] = [
    {
      chunk: {
        type: 'tool_call',
        toolCall: {
          id,
          name: call.name,
          args: call.args ?? {},
          ...(call.kind ? { kind: call.kind } : {}),
        },
      },
      delayMs: TOOL_CALL_DELAY_MS,
    },
  ]
  const subagent = call.subagent
  if (subagent) {
    steps.push({
      chunk: {
        type: 'subagent_start',
        parentToolCallId: id,
        session: {
          id: subagent.id,
          kind: subagent.kind,
          status: 'running',
          prompt: clean(subagent.prompt),
          summary: null,
          messages: [],
          ...(subagent.model ? { model: subagent.model } : {}),
        },
      },
    })
    for (const message of subagent.messages ?? []) {
      if (message.content) {
        steps.push({
          chunk: {
            type: 'subagent_text',
            parentToolCallId: id,
            messageId: message.id,
            text: clean(message.content),
          },
        })
      }
      for (const [innerIndex, innerCall] of (message.toolCalls ?? []).entries()) {
        const innerId = innerCall.id ?? `${id}-inner-${String(innerIndex)}`
        steps.push({
          chunk: {
            type: 'subagent_tool_call',
            parentToolCallId: id,
            messageId: message.id,
            toolCall: { id: innerId, name: innerCall.name, args: innerCall.args ?? {} },
          },
          delayMs: TOOL_CALL_DELAY_MS,
        })
        if (typeof innerCall.result === 'string') {
          steps.push({
            chunk: {
              type: 'subagent_tool_result',
              parentToolCallId: id,
              toolCallId: innerId,
              result: clean(innerCall.result),
              isError: innerCall.status === 'error',
            },
            delayMs: TOOL_RESULT_DELAY_MS,
          })
        }
      }
    }
    steps.push({
      chunk: {
        type: 'subagent_done',
        parentToolCallId: id,
        summary: clean(subagent.summary ?? ''),
      },
    })
  }
  if (typeof call.result === 'string') {
    steps.push({
      chunk: {
        type: 'tool_result',
        toolCallId: id,
        result: clean(call.result),
        isError: call.status === 'error',
        ...(call.editStats ? { editStats: call.editStats } : {}),
        ...(call.resultFormat ? { resultFormat: call.resultFormat } : {}),
      },
      delayMs: TOOL_RESULT_DELAY_MS,
    })
  }
  return steps
}

function buildTrace(
  thread: ThreadLine,
  messages: MessageLine[],
  options: { id: string; label: string; turn: number },
): DemoTrace {
  const userIndexes = messages.flatMap((message, index) => (message.role === 'user' ? [index] : []))
  const start = userIndexes[options.turn]
  if (start === undefined) {
    fail(
      `--turn ${String(options.turn)} is out of range: the export has ${String(userIndexes.length)} user turn(s).`,
    )
  }
  const nextUser = userIndexes.find((index) => index > start)
  const end = nextUser ?? messages.length
  const prompt = clean(messages[start]?.content ?? '')
  if (prompt === '')
    fail(`Turn ${String(options.turn)} has no user text to type into the composer.`)

  const steps: DemoTraceStep[] = []
  let model: string | undefined
  let toolIndex = 0
  const turnMessages = messages.slice(start + 1, end)
  const nativeBridgeWrites = bridgedWritePaths(turnMessages)
  for (const message of turnMessages) {
    if (message.role !== 'assistant') continue
    model ??= message.model
    if (message.reasoning)
      steps.push({ chunk: { type: 'reasoning', text: clean(message.reasoning) } })
    if (message.content) steps.push({ chunk: { type: 'text', text: clean(message.content) } })
    for (const call of message.toolCalls ?? []) {
      // Older ACP exports can contain a synthetic warning that bridged native
      // writes bypassed Copse. Those writes did pass through Copse; current
      // product code records them in the audit ledger. Preserve genuine audits,
      // but do not publish this known false positive in a replay.
      if (isRedundantWorkspaceAudit(call, nativeBridgeWrites)) continue
      steps.push(...toolCallSteps(replayToolCall(call), toolIndex))
      toolIndex += 1
    }
  }
  if (steps.length === 0) fail(`Turn ${String(options.turn)} has no assistant reply to replay.`)

  // Usage is a thread total, so it is only this turn's cost when the thread is
  // one turn long. Anything else would overstate what the demo just did.
  const usage = thread.usage
  if (userIndexes.length === 1 && usage && (usage.inputTokens ?? 0) > 0) {
    steps.push({
      chunk: {
        type: 'usage',
        model: model ?? 'unknown',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: usage.cacheCreationTokens }
          : {}),
      },
      delayMs: TURN_END_DELAY_MS,
    })
  } else if (userIndexes.length > 1) {
    console.warn(
      `[demo:trace] export has ${String(userIndexes.length)} turns — omitting the usage chunk (usage is a thread total).`,
    )
  }
  steps.push({ chunk: { type: 'done', stopReason: 'end_turn' }, delayMs: TURN_END_DELAY_MS })

  return {
    id: options.id,
    label: options.label,
    prompt,
    steps,
    source: {
      exportVersion: thread.exportVersion ?? 0,
      threadId: thread.id,
      title: thread.title ?? '',
      turn: options.turn,
      ...(model ? { model } : {}),
    },
  }
}

function moduleSource(trace: DemoTrace): string {
  const constName = `${trace.id.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_TRACE`
  return [
    '// Generated by `npm run demo:trace` from a thread JSONL export — do not edit by hand.',
    "import type { DemoTrace } from '../demo-traces.ts'",
    '',
    `export const ${constName}: DemoTrace = ${JSON.stringify(trace, null, 2)}`,
    '',
  ].join('\n')
}

const argv = process.argv.slice(2)
const input = argv[0]
if (!input || input.startsWith('--')) {
  fail(
    'Usage: npm run demo:trace -- <export.jsonl> --id <id> --label "<label>" [--turn N] [--out <path>]',
  )
}
const id = flagValue(argv, 'id')
if (!id) fail('--id is required (it names the emitted module and its exported constant).')
const label = flagValue(argv, 'label') ?? id
const turn = Number(flagValue(argv, 'turn') ?? '0')
if (!Number.isInteger(turn) || turn < 0) fail('--turn must be a non-negative integer.')
const out = resolve(flagValue(argv, 'out') ?? `src/shared/demo-traces/${id}.ts`)

const { thread, messages } = parseExport(resolve(input))
const trace = buildTrace(thread, messages, { id, label, turn })
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, moduleSource(trace))
// Emitted JSON is valid TS but not prettier-shaped; format it so `npm run check` stays green.
spawnSync('npx', ['prettier', '--write', out], { stdio: 'inherit' })
console.log(
  `[demo:trace] wrote ${out} — ${String(trace.steps.length)} steps from "${trace.source?.title ?? ''}".`,
)
console.log('[demo:trace] Read it before committing: traces ship on the public marketing page.')
