import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { CLASSIFIER_PRESETS, classifierCredentialId } from '@copse/llm/classifiers/presets.ts'
import type { ClassifierProfile } from '@copse/llm/classifiers/types.ts'
import type { ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { LLMProvider, ModelUsage } from '@shared/types'
import type { SmallTasksRoute } from '../providers/small-tasks-provider.ts'
import { deleteApiKey, deleteSetting, getSetting, setSetting } from '../storage/settings.ts'
import {
  askBackgroundChoice,
  askClassifierChoice,
  askModelChoice,
  backgroundChoicePrompt,
  backgroundClassifierQuestion,
  parseChoiceWord,
  type BackgroundChoiceQuestion,
} from './background-classification.ts'
import {
  backgroundClassifierId,
  removeClassifierProfile,
  saveClassifierProfile,
  setBackgroundClassifier,
} from './classifier-service.ts'

const SIZES = ['small', 'large'] as const

const QUESTION: BackgroundChoiceQuestion<(typeof SIZES)[number]> = {
  task: 'Rate the size of the change below',
  choices: SIZES,
  describe: { small: 'one file.', large: 'many files.' },
  guidance: 'If torn, pick small.',
  stateLabel: 'Change',
}

function preset(id: string): ClassifierProfile {
  const profile = CLASSIFIER_PRESETS.find((entry) => entry.id === id)
  assert.ok(profile)
  return profile
}

function textProvider(run: () => string, spent?: ModelUsage): LLMProvider {
  return {
    stream: async function* (): AsyncGenerator<ProviderStreamChunk> {
      if (spent) {
        yield {
          type: 'usage' as const,
          model: 'm',
          inputTokens: spent.inputTokens,
          outputTokens: spent.outputTokens,
        }
      }
      yield { type: 'text' as const, text: run() }
      yield { type: 'done' as const }
    },
  }
}

async function* routes(...list: SmallTasksRoute[]): AsyncIterable<SmallTasksRoute> {
  for (const route of list) yield route
}

/** Answer every classifier call with this distribution; returns the request bodies sent. */
function classifierAnswers(probabilities: Record<string, number>, choice = 'large'): unknown[] {
  const sent: unknown[] = []
  mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(safeJsonParse(typeof init?.body === 'string' ? init.body : ''))
    return Response.json({
      model: 'kev-fixture',
      answers: { answer: { type: 'choice', choice, probabilities } },
      usage: { input_tokens: 12, output_tokens: 1 },
    })
  })
  return sent
}

describe('background question rendering', () => {
  it('renders a one-word prompt that lists every choice with its meaning', () => {
    assert.equal(
      backgroundChoicePrompt(QUESTION, 'Rename a flag'),
      'Rate the size of the change below as exactly one word: small or large.\n' +
        '- small: one file.\n' +
        '- large: many files.\n' +
        'If torn, pick small.\n' +
        'Reply with ONLY the word.\n\n' +
        'Change:\nRename a flag',
    )
  })

  it('gives a classifier the same words as a choice question', () => {
    assert.deepEqual(backgroundClassifierQuestion(QUESTION), {
      type: 'choice',
      instructions: 'Rate the size of the change below. If torn, pick small.',
      options: { small: 'one file.', large: 'many files.' },
    })
  })
})

describe('parseChoiceWord', () => {
  const complexity = ['low', 'medium', 'high'] as const
  const category = ['bug', 'feature', 'project'] as const

  it('reads a bare verdict', () => {
    assert.equal(parseChoiceWord(complexity, 'low'), 'low')
    assert.equal(parseChoiceWord(complexity, '  High  '), 'high')
    assert.equal(parseChoiceWord(category, '  Feature  '), 'feature')
  })

  it('tolerates chatty replies, first line only', () => {
    assert.equal(parseChoiceWord(complexity, 'Medium — touches two files.'), 'medium')
    assert.equal(parseChoiceWord(complexity, 'Verdict: high\nBecause of the refactor.'), 'high')
    assert.equal(parseChoiceWord(category, 'Project — migration across three modules'), 'project')
    assert.equal(parseChoiceWord(complexity, 'I would not classify this.\nlow'), null)
  })

  it('rejects output with no verdict or embedded words', () => {
    assert.equal(parseChoiceWord(complexity, ''), null)
    assert.equal(parseChoiceWord(complexity, 'lowering the bar is highly complex'), null)
    assert.equal(parseChoiceWord(category, 'bugging the system'), null)
    assert.equal(parseChoiceWord(category, 'featurette'), null)
  })
})

describe('askModelChoice', () => {
  it('moves to the chat route when the small-tasks model fails or gives no offered word', async () => {
    const usage: Array<[string, ModelUsage]> = []
    const record = (model: string, spent: ModelUsage): void => {
      usage.push([model, spent])
    }
    const answer = await askModelChoice(
      QUESTION,
      'Rename a flag',
      1_000,
      routes(
        {
          model: 'local',
          provider: textProvider(() => 'Hard to say', { inputTokens: 5, outputTokens: 3 }),
        },
        {
          model: 'broken',
          provider: textProvider(() => {
            throw new Error('server stopped')
          }),
        },
        {
          model: 'chat',
          provider: textProvider(() => 'Large.', { inputTokens: 7, outputTokens: 1 }),
        },
      ),
      record,
    )
    assert.deepEqual(answer, { choice: 'large', source: 'model', model: 'chat' })
    // The rejected answer still spent its tokens; the failed route reports what it had.
    assert.deepEqual(
      usage.map(([model, spent]) => [model, spent.inputTokens, spent.outputTokens]),
      [
        ['local', 5, 3],
        ['broken', 0, 0],
        ['chat', 7, 1],
      ],
    )
  })

  it('returns null when no route answers', async () => {
    assert.equal(await askModelChoice(QUESTION, 'x', 1_000, routes()), null)
  })
})

describe('askClassifierChoice', () => {
  beforeEach(async () => {
    await setSetting('classifierProviders', { version: 1, profiles: [] })
    await setSetting('extraProviders', [])
    await deleteSetting('backgroundClassifier')
    for (const profile of CLASSIFIER_PRESETS) deleteApiKey(classifierCredentialId(profile.id))
  })

  afterEach(() => {
    mock.restoreAll()
    delete process.env['COPSE_PANEL_MOCK_LLM']
  })

  it('keeps the choice apart from the profiles and clears it when the connection is removed', async () => {
    await saveClassifierProfile(preset('kev'))
    await assert.rejects(setBackgroundClassifier('missing'), /not configured/)
    assert.equal(backgroundClassifierId(), null)

    assert.equal(await setBackgroundClassifier('kev'), 'kev')
    await setBackgroundClassifier(null)
    assert.equal(backgroundClassifierId(), null)
    await setBackgroundClassifier('kev')
    assert.deepEqual(Object.keys(getSetting('classifierProviders', {})), ['version', 'profiles'])
    await removeClassifierProfile('kev')
    assert.equal(backgroundClassifierId(), null)
    assert.equal(getSetting('backgroundClassifier', ''), '')

    // A choice left naming a missing connection reads as none.
    await setSetting('backgroundClassifier', 'kev')
    assert.equal(backgroundClassifierId(), null)
  })

  it('accepts a SemIf scorer, since nothing waits on a background answer', async () => {
    await saveClassifierProfile(preset('semif'))
    assert.equal(await setBackgroundClassifier('semif'), 'semif')
  })

  it('asks nothing when no connection is chosen', async () => {
    const sent = classifierAnswers({ small: 0.5, large: 0.5 })
    assert.equal(await askClassifierChoice(QUESTION, 'x'), null)
    assert.equal(sent.length, 0)
  })

  it('reads the likeliest choice from the probabilities and records usage', async () => {
    await saveClassifierProfile(preset('kev'))
    await setBackgroundClassifier('kev')
    // The provider's own `choice` disagrees; the distribution decides.
    const sent = classifierAnswers({ small: 0.7, large: 0.3 }, 'large')
    const usage: Array<[string, ModelUsage]> = []
    const answer = await askClassifierChoice(
      QUESTION,
      'Rename a flag',
      undefined,
      (model, spent) => {
        usage.push([model, spent])
      },
    )
    assert.deepEqual(answer, {
      choice: 'small',
      probabilities: { small: 0.7, large: 0.3 },
      source: 'classifier',
      model: 'kev-fixture',
    })
    assert.deepEqual(usage, [['kev-fixture', { inputTokens: 12, outputTokens: 1 }]])
    assert.equal(sent.length, 1)
    assert.match(JSON.stringify(sent[0]), /Rename a flag/)
    assert.match(JSON.stringify(sent[0]), /Rate the size of the change below/)
  })

  it('breaks a tie toward the earlier choice', async () => {
    await saveClassifierProfile(preset('kev'))
    await setBackgroundClassifier('kev')
    classifierAnswers({ small: 0.5, large: 0.5 }, 'large')
    assert.equal((await askClassifierChoice(QUESTION, 'x'))?.choice, 'small')
  })

  it('returns null for a failing connection so the models can answer', async () => {
    await saveClassifierProfile(preset('kev'))
    await setBackgroundClassifier('kev')
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed')
    })
    assert.equal(await askClassifierChoice(QUESTION, 'x'), null)
  })

  it('prefers the classifier and yields nothing when it fails and no model route exists', async () => {
    // Mock-LLM mode offers no small-tasks route, isolating the classifier step.
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    await saveClassifierProfile(preset('kev'))
    await setBackgroundClassifier('kev')
    classifierAnswers({ small: 0.2, large: 0.8 })
    assert.equal((await askBackgroundChoice(QUESTION, 'x', 1_000))?.source, 'classifier')
    mock.restoreAll()
    mock.method(globalThis, 'fetch', async () => new Response('bad gateway', { status: 502 }))
    assert.equal(await askBackgroundChoice(QUESTION, 'x', 1_000), null)
  })
})
