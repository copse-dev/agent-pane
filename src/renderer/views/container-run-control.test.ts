import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ContainerModelVerdict } from '@shared/types/container-run.ts'
import type { FetchModelOptionsOpts, ModelOption } from './model-options.ts'
import { agentModelsNote, loadRunModelOptions } from './container-run-control.ts'

/**
 * The model roster the container-run sheet offers.
 *
 * The wording of a disabled row is the part worth pinning. It first shipped as
 * "needs its own login", which reads as a task the user can go and do — and
 * they could not: signing in again would not make an agent runnable in a
 * container that is given no login. Now a row says the one thing that is true
 * of that agent: which key would make it run, or that nothing would.
 */

const PROVIDER: ModelOption = { value: 'openai:gpt-5-6-sol', label: 'GPT-5.6 Sol', group: 'OpenAI' }
const CURSOR: ModelOption = {
  value: 'acp:cursor#gpt-5-6-sol',
  label: 'GPT-5.6 Sol — intellect 59',
  group: 'Cursor on this device',
}
const CLAUDE: ModelOption = {
  value: 'acp:claude-acp#claude-opus-5',
  label: 'Opus 5',
  group: 'Claude on this device',
}
const REMOTE: ModelOption = { value: 'remote-agent:anthropic#x', label: 'Remote', group: 'Remote' }

/** Stands in for the bound `fetchModelOptions`, keyed on the flag it reads. */
function fetcher(
  all: ModelOption[],
  runnable: ModelOption[],
): (opts?: FetchModelOptionsOpts) => Promise<ModelOption[]> {
  return async (opts) => (opts?.includeAgentModels === false ? runnable : all)
}

/** Stands in for `container.modelAvailability`: the resolver's verdict per row. */
const verdicts =
  (answers: Record<string, ContainerModelVerdict | string | null>) =>
  (models: string[]): Promise<Record<string, ContainerModelVerdict>> =>
    Promise.resolve(
      Object.fromEntries(
        models.map((model) => {
          const answer = answers[model]
          return [
            model,
            answer !== null && typeof answer === 'object' ? answer : { reason: answer ?? null },
          ]
        }),
      ),
    )

describe('loadRunModelOptions', () => {
  it('enables an agent row the resolver would accept', async () => {
    const options = await loadRunModelOptions(
      fetcher([PROVIDER, CLAUDE], [PROVIDER]),
      verdicts({ [CLAUDE.value]: null }),
    )
    assert.deepEqual(
      options.find((option) => option.value === CLAUDE.value),
      CLAUDE,
    )
  })

  it('disables an agent row with the reason the resolver gives, after its label', async () => {
    const options = await loadRunModelOptions(
      fetcher([PROVIDER, CLAUDE], [PROVIDER]),
      verdicts({ [CLAUDE.value]: 'needs an Anthropic API key in Settings' }),
    )
    const claude = options.find((option) => option.value === CLAUDE.value)
    assert.ok(claude)
    assert.equal(claude.disabled, true)
    assert.equal(claude.label, 'Opus 5 — needs an Anthropic API key in Settings')
  })

  it('asks the resolver only about the rows that are not provider-backed', async () => {
    const asked: string[][] = []
    await loadRunModelOptions(fetcher([PROVIDER, CLAUDE, CURSOR], [PROVIDER]), (models) => {
      asked.push(models)
      return Promise.resolve(Object.fromEntries(models.map((model) => [model, { reason: null }])))
    })
    assert.deepEqual(asked, [[CLAUDE.value, CURSOR.value]])
  })

  it('does not ask at all when every row is provider-backed', async () => {
    let asked = 0
    const options = await loadRunModelOptions(fetcher([PROVIDER], [PROVIDER]), () => {
      asked += 1
      return Promise.resolve({})
    })
    assert.equal(asked, 0)
    assert.equal(
      options.some((option) => option.disabled === true),
      false,
    )
  })

  it('keeps a row the resolver would run on the sign-in pickable, and says so', async () => {
    const CODEX: ModelOption = {
      value: 'acp:codex-acp',
      label: 'Codex',
      group: 'Codex on this device',
    }
    const options = await loadRunModelOptions(
      fetcher([PROVIDER, CODEX], [PROVIDER]),
      verdicts({ [CODEX.value]: { reason: null, loginOffered: { agentTitle: 'Codex' } } }),
    )
    const codex = options.find((option) => option.value === CODEX.value)
    assert.ok(codex)
    assert.equal(codex.disabled, undefined)
    assert.equal(codex.label, 'Codex — on your Codex sign-in (opt in)')
  })

  it('falls back to a generic reason for a row the resolver did not answer', async () => {
    const options = await loadRunModelOptions(fetcher([PROVIDER, REMOTE], [PROVIDER]), () =>
      Promise.resolve({}),
    )
    const remote = options.find((option) => option.value === REMOTE.value)
    assert.ok(remote)
    assert.equal(remote.disabled, true)
    assert.match(remote.label, /not available in a container/)
    assert.doesNotMatch(remote.label, /log ?in|needs its own/i)
  })

  it('leaves a runnable provider model exactly as it came', async () => {
    const options = await loadRunModelOptions(
      fetcher([PROVIDER, CURSOR], [PROVIDER]),
      verdicts({ [CURSOR.value]: 'signs in through a browser; no API-key path' }),
    )
    assert.deepEqual(
      options.find((option) => option.value === PROVIDER.value),
      PROVIDER,
    )
  })
})

describe('agentModelsNote', () => {
  it('names the agents that can run and what they run on', () => {
    const note = agentModelsNote()
    assert.match(note, /Claude, Codex and Gemini CLI/)
    assert.match(note, /API key/)
    assert.match(note, /desktop sign-in if you opt in/)
  })
})
