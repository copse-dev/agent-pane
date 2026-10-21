import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentRoleId } from '@copse/llm/agent-roles.ts'
import type { ModelParameters } from '@copse/llm/model-parameters.ts'
import {
  resolveWorkflowModel,
  resolveWorkflowPanelModels,
  resolveWorkflowReviewerModels,
  type WorkflowModelHost,
} from './workflow-models.ts'

const A = 'claude-sonnet-4-6'
const B = 'gpt-5'
const signal = (): AbortSignal => new AbortController().signal

function host(
  options: {
    models?: readonly string[]
    roles?: Partial<Record<AgentRoleId, string>>
    parameters?: ModelParameters
  } = {},
): WorkflowModelHost {
  const models = options.models ?? [A, B]
  return {
    roleModel: (role) => options.roles?.[role] ?? '',
    expand: (selection, exclude) =>
      Promise.resolve(
        selection.startsWith('auto:')
          ? (models.find((model) => !exclude.includes(model)) ?? models[0] ?? '')
          : selection,
      ),
    inspect: (model): ReturnType<WorkflowModelHost['inspect']> => {
      if (!models.includes(model)) return Promise.reject(new Error(`Unavailable: ${model}`))
      return Promise.resolve({
        metered: !model.startsWith('lmstudio:'),
        parameters: options.parameters ?? {},
      })
    },
  }
}

describe('workflow model contract', () => {
  it('uses the configured role and resolves explicit overrides predictably', async () => {
    const services = host({ roles: { coder: A, research: B } })
    assert.equal((await resolveWorkflowModel({ role: 'coder' }, signal(), services)).model, A)
    assert.equal((await resolveWorkflowModel({ role: 'research' }, signal(), services)).model, B)
    assert.equal(
      (await resolveWorkflowModel({ role: 'coder', model: B }, signal(), services)).model,
      B,
    )
  })

  it('requires an explicit fallback for an unassigned or unavailable route', async () => {
    await assert.rejects(resolveWorkflowModel({ role: 'coder' }, signal(), host()), /Unassigned/)
    await assert.rejects(
      resolveWorkflowModel({ role: 'coder', model: 'gone' }, signal(), host()),
      /Unavailable: gone/,
    )
    const result = await resolveWorkflowModel(
      { role: 'coder', model: 'gone', fallback: [A] },
      signal(),
      host(),
    )
    assert.equal(result.model, A)
    assert.deepEqual(result.fallback, [{ selection: 'gone', reason: 'Unavailable: gone' }])
    assert.equal(result.requiresSpendApproval, true)
  })

  it('rejects host-owned routes before inspection, including malformed dynamic selectors', async () => {
    const services = host()
    services.inspect = (): ReturnType<WorkflowModelHost['inspect']> => {
      throw new Error('Must not inspect a host route')
    }
    services.expand = (selection): Promise<string> => Promise.resolve(selection)
    for (const model of [
      'acp:codex#gpt-5',
      'remote-agent:openai',
      'plugin-model:test:worker',
      'auto:unknown',
    ]) {
      await assert.rejects(
        resolveWorkflowModel({ role: 'coder', model }, signal(), services),
        /not a provider-callable/,
      )
    }
  })

  it('bounds role indirection and does not use workflow assignments for safety', async () => {
    const services = host({
      roles: { coder: 'auto:role:research', research: 'auto:role:coder', safety: A },
    })
    await assert.rejects(resolveWorkflowModel({ role: 'coder' }, signal(), services), /cyclic/)
    await assert.rejects(
      resolveWorkflowModel({ role: 'safety', model: A }, signal(), services),
      /Safety routing/,
    )
    await assert.rejects(
      resolveWorkflowModel({ role: 'coder', model: 'auto:role:safety' }, signal(), services),
      /Safety routing/,
    )
  })

  it('reports a same-model panel when only one model is available', async () => {
    const result = await resolveWorkflowPanelModels(
      [
        { role: 'reviewer', model: 'auto:best-value' },
        { role: 'judge', model: 'auto:best-intellect' },
      ],
      signal(),
      host({ models: [A] }),
    )
    assert.deepEqual(
      result.members.map((member) => member.model),
      [A, A],
    )
    assert.equal(result.diversity, 'same-model')
    assert.match(result.diversityNotice ?? '', /Independent cross-model review is unavailable/)
  })

  it('makes automatic Reviewer fallback explicit, while keeping unavailable pinned challengers blocked', async () => {
    const services = host({ models: ['opaque-worker'] })
    services.expand = (selection): Promise<string> =>
      selection.startsWith('auto:')
        ? Promise.reject(new Error('No scored route'))
        : Promise.resolve(selection)
    const panel = await resolveWorkflowReviewerModels(
      ['opaque-worker', 'auto:best-intellect'],
      signal(),
      services,
    )
    assert.deepEqual(
      panel.members.map((member) => member.model),
      ['opaque-worker', 'opaque-worker'],
    )
    assert.equal(panel.diversity, 'same-model')
    assert.deepEqual(panel.members[1]?.fallback, [
      { selection: 'auto:best-intellect', reason: 'No scored route' },
    ])
    await assert.rejects(
      resolveWorkflowReviewerModels(['opaque-worker', 'gone'], signal(), services),
      /Unavailable: gone/,
    )
  })

  it('rejects a reasoning ceiling the model cannot express instead of using an unbounded default', async () => {
    await assert.rejects(
      resolveWorkflowModel(
        { role: 'coder', model: 'gpt-6-astra', reasoning: 'high', maxReasoning: 'off' },
        signal(),
        host({ models: ['gpt-6-astra'] }),
      ),
      /cannot honour the requested reasoning ceiling off/,
    )
  })

  it('resolves distinct configured models from a multi-model pool', async () => {
    const result = await resolveWorkflowPanelModels(
      [
        { role: 'reviewer', model: 'auto:best-value' },
        { role: 'judge', model: 'auto:best-intellect' },
      ],
      signal(),
      host(),
    )
    assert.deepEqual(
      result.members.map((member) => member.model),
      [A, B],
    )
    assert.equal(result.diversity, 'cross-model')
    assert.equal(result.diversityNotice, null)
  })

  it('does not mistake different providers of the same weights for model diversity', async () => {
    const wrapped = `openrouter:anthropic/${A}`
    const result = await resolveWorkflowPanelModels(
      [
        { role: 'reviewer', model: A },
        { role: 'reviewer', model: wrapped },
      ],
      signal(),
      host({ models: [A, wrapped] }),
    )
    assert.equal(result.diversity, 'same-model')
  })

  it('does not claim independence for opaque models or a panel with fewer than two members', async () => {
    const result = await resolveWorkflowPanelModels(
      [
        { role: 'reviewer', model: 'custom-a' },
        { role: 'reviewer', model: 'custom-b' },
      ],
      signal(),
      host({ models: ['custom-a', 'custom-b'] }),
    )
    assert.equal(result.diversity, 'unknown')
    assert.match(result.diversityNotice ?? '', /identity is unknown/)
    assert.equal((await resolveWorkflowPanelModels([], signal(), host())).diversity, 'same-model')
  })

  it('fails the whole panel instead of silently replacing an unavailable pinned member', async () => {
    await assert.rejects(
      resolveWorkflowPanelModels(
        [
          { role: 'reviewer', model: A },
          { role: 'reviewer', model: 'gone' },
        ],
        signal(),
        host(),
      ),
      /Unavailable: gone/,
    )
  })

  it('sets the reasoning ceiling even when the model has no saved effort', async () => {
    const result = await resolveWorkflowModel(
      { role: 'coder', model: B, maxReasoning: 'low' },
      signal(),
      host(),
    )
    assert.equal(result.parameters.reasoning, 'low')
    assert.equal(result.reasoning.effective, 'low')
  })

  it('lowers reasoning to a supported level within the caller ceiling and reports the adjustment', async () => {
    const result = await resolveWorkflowModel(
      { role: 'coder', model: A, reasoning: 'xhigh', maxReasoning: 'medium' },
      signal(),
      host(),
    )
    assert.equal(result.parameters.reasoning, 'medium')
    assert.deepEqual(result.reasoning, {
      requested: 'xhigh',
      effective: 'medium',
      status: 'adjusted',
      upstreamDecides: false,
    })
    const gap = await resolveWorkflowModel(
      { role: 'coder', model: A, reasoning: 'minimal' },
      signal(),
      host(),
    )
    assert.equal(gap.parameters.reasoning, 'off')
  })

  it('reports unsupported reasoning and inherits saved parameters when no effort is requested', async () => {
    const unsupported = await resolveWorkflowModel(
      { role: 'coder', model: 'gpt-4o', reasoning: 'high' },
      signal(),
      host({ models: ['gpt-4o'] }),
    )
    assert.equal(unsupported.reasoning.status, 'unsupported')
    assert.equal(unsupported.parameters.reasoning, undefined)
    const inherited = await resolveWorkflowModel(
      { role: 'coder', model: B },
      signal(),
      host({ parameters: { reasoning: 'high', temperature: 0.4 } }),
    )
    assert.equal(inherited.reasoning.status, 'honoured')
    assert.equal(inherited.parameters.temperature, 0.4)
  })

  it('marks compatible-endpoint effort as upstream-decided and local calls as unmetered', async () => {
    const result = await resolveWorkflowModel(
      { role: 'coder', model: 'lmstudio:my-model', reasoning: 'high' },
      signal(),
      host({ models: ['lmstudio:my-model'] }),
    )
    assert.equal(result.reasoning.upstreamDecides, true)
    assert.equal(result.requiresSpendApproval, false)
  })

  it('never falls back or continues a panel after cancellation', async () => {
    const controller = new AbortController()
    const services = host()
    let calls = 0
    services.inspect = (): ReturnType<WorkflowModelHost['inspect']> => {
      calls++
      controller.abort()
      return Promise.resolve({ metered: true, parameters: {} })
    }
    await assert.rejects(
      resolveWorkflowModel({ role: 'coder', model: A, fallback: [B] }, controller.signal, services),
      { name: 'AbortError' },
    )
    assert.equal(calls, 1)
    await assert.rejects(
      resolveWorkflowPanelModels([{ role: 'reviewer', model: A }], controller.signal, services),
      { name: 'AbortError' },
    )
    assert.equal(calls, 1)
  })
})
