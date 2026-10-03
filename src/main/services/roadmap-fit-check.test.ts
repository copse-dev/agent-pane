import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ClassifierRequest, ClassifierResult } from '@copse/llm/classifiers/types.ts'
import { classifyRoadmapFit } from './roadmap-fit-check.ts'

function answering(probabilities: Record<string, number>): ClassifierResult {
  return {
    profileId: 'kev',
    adapter: 'systemone',
    requestedModel: 'kev',
    model: 'kev-fixture',
    elapsedMs: 1,
    answers: { fit: { type: 'choice', choice: 'likely', probabilities } },
  }
}

describe('classifyRoadmapFit', () => {
  it('asks one fit question about the issue and prompt, within the fit budget', async () => {
    const captured: { requests: readonly ClassifierRequest[]; timeoutMs?: number | undefined } = {
      requests: [],
    }
    await classifyRoadmapFit(
      'ISSUE #52: Toggle\n\nPROMPT:\nAdd a shortcut',
      async (requests, options) => {
        captured.requests = requests
        captured.timeoutMs = options?.timeoutMs
        return null
      },
    )
    const request = captured.requests[0]
    assert.ok(request)
    assert.equal(request.state, 'ISSUE #52: Toggle\n\nPROMPT:\nAdd a shortcut')
    const question = request.questions['fit']
    assert.ok(question?.type === 'choice')
    assert.deepEqual(Object.keys(question.options), ['unlikely', 'partial', 'likely'])
    assert.equal(captured.timeoutMs, 30_000)
  })

  it('reads the likeliest verdict, a tie going to the less hopeful one', async () => {
    assert.equal(
      await classifyRoadmapFit('x', async () => [
        answering({ unlikely: 0.1, partial: 0.2, likely: 0.7 }),
      ]),
      'likely',
    )
    assert.equal(
      await classifyRoadmapFit('x', async () => [
        answering({ unlikely: 0.1, partial: 0.45, likely: 0.45 }),
      ]),
      'partial',
    )
  })

  it('returns null when no classifier answers', async () => {
    assert.equal(await classifyRoadmapFit('x', async () => null), null)
  })
})
