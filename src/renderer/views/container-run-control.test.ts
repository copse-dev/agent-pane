import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { FetchModelOptionsOpts, ModelOption } from './model-options.ts'
import { loadRunModelOptions } from './container-run-control.ts'

/**
 * The model roster the container-run sheet offers.
 *
 * The wording of a disabled row is the part worth pinning. It first shipped as
 * "needs its own login", which reads as a task the user can go and do — and
 * they cannot: the agent is already signed in on this device (that is what "on
 * this device" in its group heading means), and signing in again would not make
 * it runnable in a container that is given no credentials at all. A reason that
 * sends someone off to fix the wrong thing is worse than no reason.
 */

const PROVIDER: ModelOption = { value: 'openai:gpt-5-6-sol', label: 'GPT-5.6 Sol', group: 'OpenAI' }
const AGENT: ModelOption = {
  value: 'acp:cursor#gpt-5-6-sol',
  label: 'GPT-5.6 Sol — intellect 59',
  group: 'Cursor on this device',
}

/** Stands in for the bound `fetchModelOptions`, keyed on the flag it reads. */
function fetcher(
  all: ModelOption[],
  runnable: ModelOption[],
): (opts?: FetchModelOptionsOpts) => Promise<ModelOption[]> {
  return async (opts) => (opts?.includeAgentModels === false ? runnable : all)
}

describe('loadRunModelOptions', () => {
  it('disables an agent model and blames the container, not the user', async () => {
    const options = await loadRunModelOptions(fetcher([PROVIDER, AGENT], [PROVIDER]))
    const agent = options.find((option) => option.value === AGENT.value)
    assert.ok(agent)
    assert.equal(agent.disabled, true)
    assert.match(agent.label, /container/i)
    // The bug this replaced: never imply a sign-in would unblock it.
    assert.doesNotMatch(agent.label, /log ?in|sign ?in|needs its own/i)
    // The original label survives, so the row is still recognisable.
    assert.ok(agent.label.startsWith(AGENT.label))
  })

  it('leaves a runnable model exactly as it came', async () => {
    const options = await loadRunModelOptions(fetcher([PROVIDER, AGENT], [PROVIDER]))
    assert.deepEqual(
      options.find((option) => option.value === PROVIDER.value),
      PROVIDER,
    )
  })

  it('disables nothing when every model is provider-backed', async () => {
    const options = await loadRunModelOptions(fetcher([PROVIDER], [PROVIDER]))
    assert.equal(
      options.some((option) => option.disabled === true),
      false,
    )
  })
})
