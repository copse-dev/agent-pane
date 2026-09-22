// A deterministic provider that plays a fixed script: each `stream` call
// yields the next step. It is what the CLI's `--provider mock` runs and what
// the Stage 2 and Stage 4 tests drive, so the whole pipeline can be exercised
// with no model and no network — the same role `MockLLMProvider` plays for the
// bench harness, with a script shape that says exactly what a reviewer, a
// challenger or a reproducer would do.
import { z } from 'zod'
import type {
  LLMMessage,
  LLMProvider,
  LLMTool,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'
import { decodeWithSchema } from '@copse/std/safe-json.ts'

export const scriptedStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    name: z.string().min(1),
    args: z.unknown(),
    /** Optional visible text before the call. */
    text: z.string().optional(),
  }),
])
export type ScriptedStep = z.infer<typeof scriptedStepSchema>
const stepsSchema = z.array(scriptedStepSchema)

/**
 * A mock script is either one step list every role plays, or a list per role
 * (`review:<lens>`, `challenge`, `reproduce`) with an optional default. Roles
 * are the names Stage 2 and Stage 4 pass to `providerFor`.
 */
export const mockScriptSchema = z.union([
  stepsSchema,
  z.object({
    default: stepsSchema.optional(),
    roles: z.record(z.string(), stepsSchema),
  }),
])
export type MockScript = z.infer<typeof mockScriptSchema>
export const decodeMockScript = decodeWithSchema(mockScriptSchema)
/** Kept for callers that only ever had a flat step list. */
export const decodeScript = decodeWithSchema(stepsSchema)

/** The steps a role plays: its own list, else the default, else nothing. */
export function stepsForRole(script: MockScript, role: string): readonly ScriptedStep[] {
  if (Array.isArray(script)) return script
  return script.roles[role] ?? script.default ?? []
}

export class ScriptedProvider implements LLMProvider {
  private readonly steps: readonly ScriptedStep[]
  private cursor = 0
  /** Every message list the provider was asked to continue, for assertions. */
  readonly calls: LLMMessage[][] = []
  lastUsage = { inputTokens: 0, outputTokens: 0 }

  constructor(steps: readonly ScriptedStep[]) {
    this.steps = steps
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- an async generator is the provider contract
  async *stream(
    messages: LLMMessage[],
    _tools: LLMTool[],
    _signal?: AbortSignal,
  ): AsyncIterable<ProviderStreamChunk> {
    this.calls.push([...messages])
    const step = this.steps[this.cursor++]
    this.lastUsage = { inputTokens: 100 + this.cursor, outputTokens: 20 }
    if (step === undefined) {
      yield { type: 'text', text: 'Script exhausted; nothing further to report.' }
      yield { type: 'done', stopReason: 'end_turn' }
      return
    }
    if (step.type === 'text') {
      yield { type: 'text', text: step.text }
      yield { type: 'done', stopReason: 'end_turn' }
      return
    }
    if (step.text !== undefined) yield { type: 'text', text: step.text }
    yield {
      type: 'tool_call',
      toolCall: { id: `call-${String(this.cursor)}`, name: step.name, args: step.args },
    }
    yield { type: 'done', stopReason: 'tool_use' }
  }
}
