import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_ROLES, AGENT_ROLE_IDS, LEGACY_ROLE_ALIASES, getAgentRole } from './agent-roles.ts'
import { BENCHMARKS } from './local-model-catalog.ts'

describe('agent roles', () => {
  it('has unique role ids', () => {
    const ids = AGENT_ROLES.map((r) => r.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.deepEqual([...AGENT_ROLE_IDS], ids)
  })

  it('gives every role a non-empty label and description', () => {
    for (const role of AGENT_ROLES) {
      assert.ok(role.label.trim().length > 0, `${role.id}: label`)
      assert.ok(role.description.trim().length > 0, `${role.id}: description`)
    }
  })

  it("only references benchmarks that exist in the catalog's benchmark set", () => {
    const known = new Set(BENCHMARKS)
    for (const role of AGENT_ROLES) {
      assert.ok(role.wants.length > 0, `${role.id}: wants must be non-empty`)
      for (const bench of role.wants) {
        assert.ok(known.has(bench), `${role.id}: unknown benchmark '${bench}'`)
      }
      // No duplicate benchmarks within a role's priority list.
      assert.equal(new Set(role.wants).size, role.wants.length, `${role.id}: duplicate wants`)
    }
  })

  it('resolves known ids and returns null for unknown ones', () => {
    assert.equal(getAgentRole('coder')?.id, 'coder')
    assert.equal(getAgentRole('not-a-role'), null)
    assert.equal(getAgentRole(''), null)
  })

  it('maps every legacy routing setting onto a real role', () => {
    for (const [settingKey, roleId] of Object.entries(LEGACY_ROLE_ALIASES)) {
      assert.ok(getAgentRole(roleId), `${settingKey} → unknown role '${roleId}'`)
    }
  })

  it('covers the three implicit roles that exist today (chat / smallTasks / safety)', () => {
    // The legacy `PreferredModelRole`s must all have a home in the new registry.
    assert.ok(getAgentRole(LEGACY_ROLE_ALIASES['localDefaultModel'] ?? ''), 'chat → coder')
    assert.ok(getAgentRole(LEGACY_ROLE_ALIASES['smallTasksModel'] ?? ''), 'smallTasks')
    assert.ok(getAgentRole(LEGACY_ROLE_ALIASES['safetyModel'] ?? ''), 'safety')
  })
})
