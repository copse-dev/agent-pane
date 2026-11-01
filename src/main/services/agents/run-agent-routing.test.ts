import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { computeParetoFrontier } from '@copse/llm/pareto-frontier.ts'
import { runAgentParameters } from '../../tools/run-agent-tool.ts'
import { setSetting } from '../storage/settings.ts'
import { pickAgentRoute, resolveRunAgentRoute } from './run-agent-routing.ts'

describe('generic subagent routing', () => {
  const previousMock = process.env['COPSE_PANEL_MOCK_LLM']
  beforeEach(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    await setSetting('roleModels', {})
    await setSetting('blockedModelMakers', [])
    await setSetting('reviewModel', '')
  })
  afterEach(async () => {
    await setSetting('roleModels', {})
    await setSetting('reviewModel', '')
    if (previousMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
    else process.env['COPSE_PANEL_MOCK_LLM'] = previousMock
  })

  it('selects a callable route meeting the floor and refuses an unmet floor', () => {
    const pool = computeParetoFrontier([
      { id: 'weak', intellect: 1, costPerMTok: 0 },
      { id: 'strong', intellect: 100, costPerMTok: 2 },
      { id: 'acp:external#strong', intellect: 100, costPerMTok: 0 },
    ])
    assert.equal(pickAgentRoute(pool, 'top'), 'strong')
    assert.equal(pickAgentRoute(pool, 'low'), 'weak')
    assert.throws(
      () =>
        pickAgentRoute(
          pool.filter((point) => point.id === 'weak'),
          'top',
        ),
      /No available callable model/,
    )
    assert.throws(() => pickAgentRoute([], 'mid'), /No available callable model/)
  })

  it('honours configured roles and reports capability mismatches', async () => {
    await setSetting('roleModels', { planner: 'gpt-4o-mini' })
    const route = await resolveRunAgentRoute(
      runAgentParameters.parse({
        task: 'Plan a migration',
        context: '',
        tools: [],
        task_type: 'planner',
        intelligence: 'top',
      }),
    )
    assert.equal(route.role, 'planner')
    assert.equal(route.model, 'gpt-4o-mini')
    assert.equal(route.source, 'settings')
    assert.match(route.warning ?? '', /below the requested/)
  })

  it('matches the child task and preserves protected review assignments', async () => {
    await setSetting('roleModels', {
      reviewer: 'gpt-4o-mini',
      'security-auditor': 'claude-sonnet-4-6',
    })
    await setSetting('reviewModel', 'claude-opus-4-8')
    const request = runAgentParameters.parse({
      task: 'Review this implementation',
      context: '',
      tools: [],
    })
    assert.equal((await resolveRunAgentRoute(request)).model, 'claude-opus-4-8')
    const security = await resolveRunAgentRoute({
      ...request,
      task: 'Find security vulnerabilities',
    })
    assert.equal(security.role, 'security-auditor')
    assert.equal(security.model, 'claude-sonnet-4-6')
  })

  it('rejects configured external agent routes rather than silently choosing another model', async () => {
    await setSetting('roleModels', { planner: 'acp:claude' })
    await assert.rejects(
      resolveRunAgentRoute(
        runAgentParameters.parse({
          task: 'Plan',
          context: '',
          tools: [],
          task_type: 'planner',
        }),
      ),
      /not a callable workflow route/,
    )
  })
})
