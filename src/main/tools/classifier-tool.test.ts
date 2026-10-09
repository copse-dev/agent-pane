import assert from 'node:assert/strict'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { describe, it } from 'node:test'
import { CLASSIFIER_PRESETS } from '@copse/llm/classifiers/presets.ts'
import type {
  ClassifierProfile,
  ClassifierQuestion,
  ClassifierResult,
} from '@copse/llm/classifiers/types.ts'
import type { LLMTool } from '@shared/types'
import {
  CLASSIFY_TEXT_MAX_CHARS,
  CLASSIFY_TEXT_TOOL_NAME,
  createClassifyTextTool,
  withClassifierToolOffer,
} from './classifier-tool.ts'

function preset(id: string): ClassifierProfile {
  const profile = CLASSIFIER_PRESETS.find((entry) => entry.id === id)
  assert.ok(profile)
  return profile
}

function result(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
  return {
    profileId: 'kev',
    adapter: 'systemone',
    requestedModel: 'kev-4b',
    model: 'kev-4b-r1',
    elapsedMs: 41,
    usage: { inputTokens: 120, outputTokens: 3 },
    metadata: { providerBody: 'must not be forwarded' },
    requestId: 'req-secret-id',
    answers: {
      answer: {
        type: 'choice',
        choice: 'blue',
        probabilities: { bug: 0.7, question: 0.3 },
      },
    },
    ...overrides,
  }
}

interface Call {
  id: string
  state: string
  question: ClassifierQuestion
}

function toolWith(
  answer: ClassifierResult | Error,
  profiles: ClassifierProfile[] = [preset('kev')],
): {
  tool: ReturnType<typeof createClassifyTextTool>
  calls: Call[]
  usage: Array<{ model: string; inputTokens: number; outputTokens: number; provider?: string }>
} {
  const calls: Call[] = []
  const usage: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    provider?: string
  }> = []
  const tool = createClassifyTextTool({
    profiles: () => profiles,
    classify: async (id, state, question) => {
      calls.push({ id, state, question })
      if (answer instanceof Error) throw answer
      return answer
    },
    recordUsage: (model, tokens, provider) => {
      usage.push({ model, ...tokens, ...(provider ? { provider } : {}) })
    },
  })
  return { tool, calls, usage }
}

const signal = new AbortController().signal

describe('classify_text', () => {
  it('asks the chosen classifier a choice question and reads the verdict from the probabilities', async () => {
    const { tool, calls } = toolWith(result())
    const out = await tool.execute(
      {
        classifier: 'kev',
        text: 'The app crashes on save.',
        type: 'choice',
        question: 'What kind of report is this?',
        options: ['bug', 'question'],
      },
      signal,
    )
    assert.deepEqual(calls, [
      {
        id: 'kev',
        state: 'The app crashes on save.',
        question: {
          type: 'choice',
          instructions: 'What kind of report is this?',
          options: { bug: null, question: null },
        },
      },
    ])
    // The provider's own `choice` ("blue") is not an offered option and is ignored.
    assert.deepEqual(parse(out), {
      classifier: 'kev',
      model: 'kev-4b-r1',
      elapsedMs: 41,
      type: 'choice',
      choice: 'bug',
      probabilities: { bug: 0.7, question: 0.3 },
    })
  })

  it('breaks a tie toward the option listed first', async () => {
    const tie = result({
      answers: {
        answer: { type: 'choice', choice: 'b', probabilities: { a: 0.5, b: 0.5 } },
      },
    })
    const { tool } = toolWith(tie)
    const out = await tool.execute(
      { classifier: 'kev', text: 't', type: 'choice', question: 'q', options: ['a', 'b'] },
      signal,
    )
    assert.equal(parse(out)['choice'], 'a')
  })

  it('answers a boolean question with a probability and no invented threshold', async () => {
    const { tool, calls } = toolWith(
      result({ answers: { answer: { type: 'boolean', probability: 0.123456 } } }),
    )
    const out = await tool.execute(
      { classifier: 'kev', text: 'rm -rf /', type: 'boolean', question: 'Is this destructive?' },
      signal,
    )
    assert.deepEqual(calls[0]?.question, { type: 'boolean', instructions: 'Is this destructive?' })
    const parsed = parse(out)
    assert.equal(parsed['type'], 'boolean')
    assert.equal(parsed['probabilityTrue'], 0.1235)
    assert.equal('choice' in parsed, false)
  })

  it('returns only the fixed fields: no provider metadata, request id or raw body', async () => {
    const { tool } = toolWith(result())
    const out = await tool.execute(
      {
        classifier: 'kev',
        text: 't',
        type: 'choice',
        question: 'q',
        options: ['bug', 'question'],
      },
      signal,
    )
    assert.equal(out.includes('must not be forwarded'), false)
    assert.equal(out.includes('req-secret-id'), false)
    assert.ok(out.length < 400, `a bounded result, got ${String(out.length)} characters`)
  })

  it('keeps even a 16-option answer small', async () => {
    const options = Array.from({ length: 16 }, (_, index) => `option-${String(index)}`)
    const probabilities = Object.fromEntries(options.map((option) => [option, 1 / 16]))
    const { tool } = toolWith(
      result({ answers: { answer: { type: 'choice', choice: 'option-0', probabilities } } }),
    )
    const out = await tool.execute(
      { classifier: 'kev', text: 't', type: 'choice', question: 'q', options },
      signal,
    )
    assert.ok(out.length < 1_000)
  })

  it('records the call against its connection, model and tokens', async () => {
    const { tool, usage } = toolWith(result())
    await tool.execute(
      { classifier: 'kev', text: 't', type: 'choice', question: 'q', options: ['bug', 'question'] },
      signal,
    )
    assert.deepEqual(usage, [
      { model: 'kev-4b-r1', inputTokens: 120, outputTokens: 3, provider: 'Kev (local)' },
    ])
  })

  it('records nothing when the provider reports no tokens', async () => {
    const { tool, usage } = toolWith(result({ usage: {} }))
    await tool.execute(
      { classifier: 'kev', text: 't', type: 'choice', question: 'q', options: ['bug', 'question'] },
      signal,
    )
    assert.deepEqual(usage, [])
  })

  it('names the configured classifiers instead of calling when the id is unknown', async () => {
    const { tool, calls } = toolWith(result(), [preset('kev'), preset('winnow')])
    const out = await tool.execute(
      { classifier: 'nope', text: 't', type: 'boolean', question: 'q' },
      signal,
    )
    assert.match(out, /No classifier "nope" is configured\. Configured: kev, winnow\./)
    assert.deepEqual(calls, [])
  })

  it('rejects a malformed choice question before any call', async () => {
    const { tool, calls } = toolWith(result())
    const missing = await tool.execute(
      { classifier: 'kev', text: 't', type: 'choice', question: 'q' },
      signal,
    )
    assert.match(missing, /needs `options`/)
    const duplicate = await tool.execute(
      { classifier: 'kev', text: 't', type: 'choice', question: 'q', options: ['a', 'a'] },
      signal,
    )
    assert.match(duplicate, /distinct/)
    assert.deepEqual(calls, [])
  })

  it('bounds its input: text, options and question length are validated by the schema', () => {
    const { tool } = toolWith(result())
    const base = { classifier: 'kev', text: 't', type: 'boolean', question: 'q' }
    assert.equal(tool.parameters.safeParse(base).success, true)
    assert.equal(
      tool.parameters.safeParse({ ...base, text: 'x'.repeat(CLASSIFY_TEXT_MAX_CHARS + 1) }).success,
      false,
    )
    assert.equal(tool.parameters.safeParse({ ...base, text: '' }).success, false)
    assert.equal(
      tool.parameters.safeParse({
        ...base,
        type: 'choice',
        options: Array.from({ length: 17 }, (_, index) => `o${String(index)}`),
      }).success,
      false,
    )
    assert.equal(tool.parameters.safeParse({ ...base, type: 'score' }).success, false)
  })

  it('lets a transport failure surface as the tool error without a result', async () => {
    const { tool, usage } = toolWith(new Error('The classifier timed out.'))
    await assert.rejects(
      Promise.resolve(
        tool.execute({ classifier: 'kev', text: 't', type: 'boolean', question: 'q' }, signal),
      ),
      /timed out/,
    )
    assert.deepEqual(usage, [])
  })

  it('fails closed when the answer leaves an offered option out', async () => {
    const { tool } = toolWith(
      result({ answers: { answer: { type: 'choice', choice: 'bug', probabilities: { bug: 1 } } } }),
    )
    await assert.rejects(
      Promise.resolve(
        tool.execute(
          {
            classifier: 'kev',
            text: 't',
            type: 'choice',
            question: 'q',
            options: ['bug', 'question'],
          },
          signal,
        ),
      ),
      /did not answer every option/,
    )
  })
})

describe('offering classify_text', () => {
  const tools: LLMTool[] = [
    { name: 'read_file', description: 'Read.', parameters: {} },
    { name: CLASSIFY_TEXT_TOOL_NAME, description: 'static', parameters: {} },
  ]

  it('withholds the tool until a classifier is configured', () => {
    assert.deepEqual(
      withClassifierToolOffer(tools, []).map((tool) => tool.name),
      ['read_file'],
    )
  })

  it('names the configured classifiers in the description once there is one', () => {
    const offered = withClassifierToolOffer(tools, [preset('kev'), preset('typesafe')])
    const tool = offered.find((candidate) => candidate.name === CLASSIFY_TEXT_TOOL_NAME)
    assert.match(tool?.description ?? '', /Configured classifiers: kev \(Kev \(local\)\), typesafe/)
    assert.equal(offered.find((candidate) => candidate.name === 'read_file')?.description, 'Read.')
  })
})

function parse(text: string): Record<string, unknown> {
  const value = safeJsonParse(text)
  assert.ok(isRecord(value), 'a JSON object')
  return value
}
