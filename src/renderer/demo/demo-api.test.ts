import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import { DEMO_SCENARIOS } from '@shared/demo-scenarios.ts'
import { createDemoApi } from './demo-api.ts'

const tracedScenario = DEMO_SCENARIOS.find((entry) => entry.trace !== undefined)

/** The renderer sends a JSON `AgentRunPayload`, not a bare string. */
function payload(text: string): string {
  return JSON.stringify({ content: text })
}

/** Emitted chunks for one run, once the run has gone quiet. */
async function runAndCollect(
  api: ReturnType<typeof createDemoApi>,
  text: string,
): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  const stop = api.agent.onChunk((_threadId, chunk) => seen.push(chunk))
  await api.agent.run('p', 't', payload(text))
  await new Promise((resolve) => setTimeout(resolve, 50))
  stop()
  return seen
}

describe('createDemoApi decisions surface', () => {
  it('exposes list/export stubs so ApiClient stays complete for the browser demo', async () => {
    const scenario = DEMO_SCENARIOS[0]
    assert.ok(scenario, 'expected at least one demo scenario')
    const api = createDemoApi(scenario)
    assert.deepEqual(await api.decisions.list(), [])
    assert.deepEqual(await api.decisions.export(), { path: '', count: 0 })
  })
})

describe('createDemoApi trace replay', () => {
  it('replays the recorded turn when its own prompt is sent', async () => {
    assert.ok(tracedScenario?.trace, 'expected a scenario carrying a trace')
    const api = createDemoApi(tracedScenario, { trace: { instant: true } })
    const seen = await runAndCollect(api, tracedScenario.trace.prompt)

    const recorded = new Set(tracedScenario.trace.steps.map((step) => step.chunk.type))
    for (const type of recorded) {
      assert.ok(
        seen.some((chunk) => chunk.type === type),
        `expected a '${type}' chunk from the replay`,
      )
    }
    assert.equal(seen.at(-1)?.type, 'done')
  })

  it('answers an off-script prompt with the stub instead of the recorded answer', async () => {
    assert.ok(tracedScenario?.trace, 'expected a scenario carrying a trace')
    const api = createDemoApi(tracedScenario, { trace: { instant: true } })
    const seen = await runAndCollect(api, 'something nobody recorded')

    const text = seen
      .filter((chunk) => chunk.type === 'text')
      .map((chunk) => chunk.text)
      .join('')
    assert.match(text, /^Demo response to:/)
    assert.doesNotMatch(text, /build output/)
  })

  it('lets the composer send at all — the checkout and branch stubs must resolve', async () => {
    assert.ok(tracedScenario)
    const api = createDemoApi(tracedScenario)
    // Both are called on the way to `agent.run`; rejecting either replaces the
    // answer with a retry error, and both silently dropped their leading
    // (projectId, threadId) arguments before this scenario ever sent anything.
    assert.equal((await api.git.branchStatus('p', 't')).currentBranch, 'main')
    assert.equal(
      (await api.agent.prepareCheckout('p', 't', 'hello', 'automatic')).checkoutMode,
      'shared',
    )
  })
})
