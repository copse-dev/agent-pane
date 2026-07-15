import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ROUTED_SETTING_TO_ROLE, resolveRoutedModel, type RoleModels } from './role-models.ts'

// The legacy reader records what key/fallback it was asked for and returns a
// sentinel so tests can assert "fell back to legacy" without a settings store.
interface LegacyReader {
  legacy: (key: string, fallback: string) => string
  calls: Array<{ key: string; fallback: string }>
}

function legacyReader(returns = 'LEGACY'): LegacyReader {
  const calls: Array<{ key: string; fallback: string }> = []
  const legacy = (key: string, fallback: string): string => {
    calls.push({ key, fallback })
    return returns
  }
  return { legacy, calls }
}

describe('role model resolution', () => {
  it('prefers a role assignment over the legacy setting', () => {
    const { legacy, calls } = legacyReader()
    const roleModels: RoleModels = { coder: 'lmstudio:my-coder' }
    const model = resolveRoutedModel('localDefaultModel', 'fallback', { roleModels, legacy })
    assert.equal(model, 'lmstudio:my-coder')
    assert.equal(calls.length, 0, 'legacy setting must not be consulted when a role is assigned')
  })

  it('falls back to the legacy setting when the role is unassigned', () => {
    const { legacy, calls } = legacyReader('lmstudio:legacy')
    const model = resolveRoutedModel('localDefaultModel', 'fallback', { roleModels: {}, legacy })
    assert.equal(model, 'lmstudio:legacy')
    assert.deepEqual(calls, [{ key: 'localDefaultModel', fallback: 'fallback' }])
  })

  it('ignores a blank/whitespace role assignment', () => {
    const { legacy } = legacyReader('lmstudio:legacy')
    const model = resolveRoutedModel('smallTasksModel', '', {
      roleModels: { 'small-tasks': '   ' },
      legacy,
    })
    assert.equal(model, 'lmstudio:legacy')
  })

  it('never routes unmapped keys — security settings stay on their legacy value', () => {
    const { legacy } = legacyReader('lmstudio:security')
    // Even if a same-named role is assigned, an unrouted key resolves to legacy.
    const roleModels: RoleModels = { safety: 'lmstudio:sneaky', reviewer: 'lmstudio:sneaky' }
    assert.equal(resolveRoutedModel('safetyModel', '', { roleModels, legacy }), 'lmstudio:security')
    assert.equal(resolveRoutedModel('reviewModel', '', { roleModels, legacy }), 'lmstudio:security')
    assert.equal(resolveRoutedModel('unknownKey', '', { roleModels, legacy }), 'lmstudio:security')
  })

  it('routes exactly the renderer-writable roles', () => {
    assert.deepEqual(ROUTED_SETTING_TO_ROLE, {
      localDefaultModel: 'coder',
      smallTasksModel: 'small-tasks',
      subagentModel: 'research',
      advisorModel: 'advisor',
    })
  })

  it('routes the advisor role for the advisor strategy', () => {
    const { legacy } = legacyReader()
    const roleModels: RoleModels = { advisor: 'claude-opus-4-8' }
    assert.equal(resolveRoutedModel('advisorModel', '', { roleModels, legacy }), 'claude-opus-4-8')
  })

  it('routes the research role for the exploration subagent', () => {
    const { legacy } = legacyReader()
    const roleModels: RoleModels = { research: 'lmstudio:explorer' }
    assert.equal(
      resolveRoutedModel('subagentModel', '', { roleModels, legacy }),
      'lmstudio:explorer',
    )
  })
})
