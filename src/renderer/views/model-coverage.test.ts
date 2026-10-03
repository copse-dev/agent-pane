import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { resolveExtraProviders } from '@copse/llm/extra-providers.ts'
import { modelCoverage } from './model-coverage.ts'

const agent: AcpAgentConfig = {
  id: 'claude-acp',
  title: 'Claude Code',
  command: 'claude-agent-acp',
  enabled: true,
  availableModels: [
    { value: 'sonnet', label: 'Claude Sonnet 4.6' },
    { value: 'opus', label: 'Claude Opus 4.8' },
  ],
}
const planUsage: PlanUsageSnapshot = {
  checkedAt: '2026-10-01T00:00:00Z',
  providers: [
    {
      status: 'ok',
      provider: 'claude',
      usage: {
        provider: 'claude',
        plan: 'Max',
        checkedAt: '2026-10-01T00:00:00Z',
        windows: [
          { id: 'seven_day', label: 'Weekly', usedPercent: 20, resetsAt: null },
          { id: 'seven_day_opus', label: 'Weekly Opus', usedPercent: 100, resetsAt: null },
        ],
      },
    },
  ],
}
const context = {
  agents: [agent],
  extraProviders: resolveExtraProviders([
    { slug: 'my-local', label: 'My local server', baseUrl: 'http://localhost:1234/v1' },
  ]),
  planUsage,
}

describe('model route coverage', () => {
  it('recognizes local inference rather than agents merely running on this device', () => {
    assert.equal(modelCoverage('lmstudio:qwen', context), 'local')
    assert.equal(modelCoverage('my-local:qwen', context), 'local')
    assert.equal(modelCoverage('acp:unknown#qwen', context), 'paid')
  })

  it('requires a known plan on the selected route, including canonical agent aliases', () => {
    assert.equal(modelCoverage('acp:claude-agent-acp#sonnet', context), 'plan')
    assert.equal(modelCoverage('claude-sonnet-4-6', context), 'paid')
    assert.equal(modelCoverage('remote-agent:anthropic#claude-sonnet-4-6', context), 'paid')
    assert.equal(modelCoverage('openrouter:anthropic/claude-sonnet-4.6', context), 'paid')
  })

  it('honors exhausted model-specific limits and missing usage', () => {
    assert.equal(modelCoverage('acp:claude-acp#opus', context), 'paid')
    assert.equal(modelCoverage('acp:claude-acp#sonnet', { ...context, planUsage: null }), 'paid')
    assert.equal(
      modelCoverage('acp:claude-acp#sonnet', {
        ...context,
        planUsage: {
          ...planUsage,
          providers: [{ status: 'error', provider: 'claude', message: 'Unavailable' }],
        },
      }),
      'paid',
    )
  })

  it('does not attribute a probed account plan to disabled agents or API overrides', () => {
    assert.equal(
      modelCoverage('acp:claude-acp#sonnet', {
        ...context,
        agents: [{ ...agent, enabled: false }],
      }),
      'paid',
    )
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      assert.equal(
        modelCoverage('acp:claude-acp#sonnet', {
          ...context,
          agents: [{ ...agent, env: { [key]: 'override' } }],
        }),
        'paid',
      )
    }
  })

  it('leaves unresolved automatic selectors and empty rows unclassified', () => {
    assert.equal(modelCoverage('auto:best-value', context), undefined)
    assert.equal(modelCoverage('', context), undefined)
  })

  it('recognizes Codex plan coverage but keeps explicit API authentication chargeable', () => {
    const codex: AcpAgentConfig = {
      id: 'codex-acp',
      title: 'Codex',
      command: 'codex-acp',
      enabled: true,
    }
    const codexUsage: PlanUsageSnapshot = {
      checkedAt: planUsage.checkedAt,
      providers: [
        {
          status: 'ok',
          provider: 'codex',
          usage: {
            provider: 'codex',
            plan: 'Pro',
            checkedAt: planUsage.checkedAt,
            windows: [{ id: 'primary', label: 'Primary', usedPercent: 10, resetsAt: null }],
          },
        },
      ],
    }
    const codexContext = { ...context, agents: [codex], planUsage: codexUsage }
    assert.equal(modelCoverage('acp:codex#gpt-5.4', codexContext), 'plan')
    for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
      assert.equal(
        modelCoverage('acp:codex#gpt-5.4', {
          ...codexContext,
          agents: [{ ...codex, env: { [key]: 'override' } }],
        }),
        'paid',
      )
    }
  })
})
