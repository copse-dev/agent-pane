// A deterministic provider that plays a fixed script: each `stream` call
// yields the next step. It is what the CLI's `--provider mock` runs and what
// the Stage 2 tests drive, so the whole pipeline can be exercised with no
// model and no network — the same role `MockLLMProvider` plays for the bench
// harness, with a script shape that says exactly what a reviewer would do.
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
export const decodeScript = decodeWithSchema(z.array(scriptedStepSchema))

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
