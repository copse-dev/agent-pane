import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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

const keys =
  (configured: Record<string, boolean>): (() => Promise<Record<string, boolean>>) =>
  () =>
    Promise.resolve(configured)

describe('loadRunModelOptions', () => {
  it('enables a key-capable agent when its key is configured', async () => {
    const options = await loadRunModelOptions(
      fetcher([PROVIDER, CLAUDE], [PROVIDER]),
      keys({ anthropic: true }),
    )
    assert.deepEqual(
      options.find((option) => option.value === CLAUDE.value),
      CLAUDE,
    )
  })

  it('disables a key-capable agent without its key and names the key', async () => {
    const options = await loadRunModelOptions(
      fetcher([PROVIDER, CLAUDE], [PROVIDER]),
      keys({ anthropic: false }),
    )
    const claude = options.find((option) => option.value === CLAUDE.value)
    assert.ok(claude)
    assert.equal(claude.disabled, true)
    assert.equal(claude.label, 'Opus 5 — needs an Anthropic API key in Settings')
  })

  it('disables a browser-login agent with its own reason, never a sign-in hint', async () => {
    const options = await loadRunModelOptions(
      fetcher([PROVIDER, CURSOR], [PROVIDER]),
      keys({ cursor: true }),
    )
    const cursor = options.find((option) => option.value === CURSOR.value)
    assert.ok(cursor)
    assert.equal(cursor.disabled, true)
    assert.match(cursor.label, /signs in through a browser/)
    assert.doesNotMatch(cursor.label, /log ?in|needs its own/i)
    assert.ok(cursor.label.startsWith(CURSOR.label))
  })

  it('keeps the generic reason for agents that are not ACP', async () => {
    const options = await loadRunModelOptions(fetcher([PROVIDER, REMOTE], [PROVIDER]), keys({}))
    assert.match(
      options.find((option) => option.value === REMOTE.value)?.label ?? '',
      /not available in a container/,
    )
  })

  it('leaves a runnable provider model exactly as it came', async () => {
    const options = await loadRunModelOptions(fetcher([PROVIDER, CURSOR], [PROVIDER]), keys({}))
    assert.deepEqual(
      options.find((option) => option.value === PROVIDER.value),
      PROVIDER,
    )
  })

  it('disables nothing when every model is provider-backed', async () => {
    const options = await loadRunModelOptions(fetcher([PROVIDER], [PROVIDER]), keys({}))
    assert.equal(
      options.some((option) => option.disabled === true),
      false,
    )
  })
})

describe('agentModelsNote', () => {
  it('names the agents that can run and what they run on', () => {
    const note = agentModelsNote()
    assert.match(note, /Claude, Codex and Gemini CLI/)
    assert.match(note, /API key/)
    assert.match(note, /never your login/)
  })
})
