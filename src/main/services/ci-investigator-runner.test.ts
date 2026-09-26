import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import { ScriptedProvider } from '@copse/review/scripted-provider.ts'
import {
  getCiInvestigatorRunner,
  runWithCiInvestigatorContext,
  type CiInvestigatorRunnerContext,
} from './ci-investigator-runner.ts'
import type { runCiInvestigatorSubagent } from './github/ci-investigator-service.ts'
import { ToolRegistry } from './tool-registry.ts'

function threadContext(
  threadId: string,
  streamed: Map<string, string[]>,
): CiInvestigatorRunnerContext {
  const chunks: string[] = []
  streamed.set(threadId, chunks)
  return {
    parentToolCallId: `call-${threadId}`,
    parentGoal: `goal of ${threadId}`,
    provider: new ScriptedProvider([]),
    registry: new ToolRegistry(),
    contextWindow: 100_000,
    toolSchemaReserve: 0,
    onChunk: (chunk: StreamChunk): void => {
      if (chunk.type === 'text') chunks.push(chunk.text)
    },
    usageModel: 'm',
  }
}

// Stands in for the subagent: reports which context it was handed and streams
// through that context's onChunk, as the real subagent does.
const fakeInvestigate: typeof runCiInvestigatorSubagent = (opts) => {
  opts.onChunk({ type: 'text', text: `from ${opts.parentToolCallId}` })
  return Promise.resolve({
    summary: `${opts.parentToolCallId}|${opts.parentGoal}`,
    usage: { inputTokens: 0, outputTokens: 0 },
  })
}

// The tool reads its context only after awaiting inside the registry
// (permission checks); `pause` models that gap.
async function afterPause(pause: number): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, pause))
  const runner = getCiInvestigatorRunner(fakeInvestigate)
  if (runner === null) return 'no context'
  const { summary } = await runner({ signal: new AbortController().signal })
  return summary
}

describe('investigate_ci tool context', () => {
  it("keeps concurrent threads' calls bound to their own context", async () => {
    const streamed = new Map<string, string[]>()
    const a = threadContext('thread-a', streamed)
    const b = threadContext('thread-b', streamed)
    const results = await Promise.all([
      runWithCiInvestigatorContext(a, () => afterPause(0)),
      runWithCiInvestigatorContext(b, () => afterPause(30)),
    ])
    assert.deepEqual(results, ['call-thread-a|goal of thread-a', 'call-thread-b|goal of thread-b'])
    assert.deepEqual(streamed.get('thread-a'), ['from call-thread-a'])
    assert.deepEqual(streamed.get('thread-b'), ['from call-thread-b'])
    assert.equal(getCiInvestigatorRunner(fakeInvestigate), null, 'no context outside a tool call')
  })

  it('control: a process-global slot under the same interleaving swaps contexts', async () => {
    // Replays the removed set/clear-around-execute pattern with the same pauses,
    // proving the interleaving above is one a shared slot gets wrong.
    let slot: string | null = null
    const readSlot = (): string | null => slot
    const call = async (threadId: string, pause: number): Promise<string> => {
      slot = threadId
      try {
        await new Promise((resolve) => setTimeout(resolve, pause))
        return readSlot() ?? 'no context'
      } finally {
        slot = null
      }
    }
    const results = await Promise.all([call('thread-a', 0), call('thread-b', 30)])
    // thread-a reads thread-b's context; thread-b then finds the slot cleared.
    assert.deepEqual(results, ['thread-b', 'no context'])
  })
})
