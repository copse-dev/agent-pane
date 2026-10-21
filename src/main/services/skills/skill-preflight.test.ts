import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SkillMetadata } from '@shared/types/skills.ts'
import {
  preflightSkill,
  skillPreflightNotice,
  type SkillPreflightEnvironment,
} from './skill-preflight.ts'

const workflow: SkillMetadata = {
  name: 'workflow',
  description: 'Workflow',
  source: 'project',
  skillPath: '/skills/workflow/SKILL.md',
  skillRoot: '/skills/workflow',
  disableModelInvocation: false,
  paths: [],
  externalLinks: [],
  missingReferences: [],
  requirements: { tools: ['image_gen'], agents: ['reviewer'], executors: ['native'] },
  dependencies: ['leaf'],
}

describe('explicit skill preflight', () => {
  it('finds transitive blockers early and deduplicates declared cycles without loading files', () => {
    const root = { ...workflow, requirements: {}, dependencies: ['leaf'] }
    const leaf = {
      ...workflow,
      name: 'leaf',
      skillPath: '/skills/leaf/SKILL.md',
      requirements: { tools: ['leaf_tool'] },
      dependencies: ['workflow'],
    }
    const skills = new Map([
      ['workflow', root],
      ['leaf', leaf],
    ])
    const result = preflightSkill(root, {
      tools: [],
      dependencyState: () => 'supported',
      dependencySkill: (_parent, name) => skills.get(name) ?? null,
    })
    assert.equal(result.status, 'blocked')
    assert.equal(result.checks.filter((check) => check.kind === 'tool').length, 1)
    assert.match(
      result.checks.find((check) => check.kind === 'tool')?.reason ?? '',
      /Dependency skill "leaf".*leaf_tool/,
    )
  })

  it('bounds metadata graph inspection and leaves further declarations untested', () => {
    const skills = Array.from({ length: 18 }, (_, index): SkillMetadata => ({
      ...workflow,
      name: `node-${String(index)}`,
      skillPath: `/skills/node-${String(index)}/SKILL.md`,
      requirements: {},
      dependencies: index < 17 ? [`node-${String(index + 1)}`] : [],
    }))
    const root = skills[0]
    assert.ok(root)
    const byName = new Map(skills.map((skill) => [skill.name, skill]))
    let inspected = 0
    const result = preflightSkill(root, {
      dependencyState: () => 'supported',
      dependencySkill: (_parent, name) => {
        inspected++
        return byName.get(name) ?? null
      },
    })
    assert.equal(result.status, 'untested')
    assert.equal(inspected, 17)
    assert.equal(result.checks.at(-1)?.state, 'untested')
    assert.match(result.checks.at(-1)?.reason ?? '', /sixteen-dependency inspection limit/)
  })
  it('reports missing tools/agents, disabled dependencies, executor restrictions and real missing files together', () => {
    const result = preflightSkill(
      { ...workflow, missingReferences: ['scripts/real.sh'] },
      {
        tools: ['read_skill'],
        executor: 'acp',
        agentState: () => 'unavailable',
        dependencyState: () => 'disabled',
      },
    )
    assert.equal(result.status, 'blocked')
    assert.deepEqual(
      result.checks.map(({ kind, name, state }) => [kind, name, state]),
      [
        ['tool', 'image_gen', 'unavailable'],
        ['agent', 'reviewer', 'unavailable'],
        ['dependency', 'leaf', 'disabled'],
        ['executor', 'acp', 'unsupported'],
        ['supporting-file', 'scripts/real.sh', 'unavailable'],
      ],
    )
    assert.match(result.checks[0]?.reason ?? '', /Enable its provider\/plugin/)
    assert.match(result.checks[1]?.reason ?? '', /Install its definition/)
    assert.match(result.checks[2]?.reason ?? '', /Settings → Customise/)
    assert.match(result.checks[3]?.reason ?? '', /Choose one of: native/)
  })

  it('keeps unknown facts and entire workflow compatibility untested', () => {
    assert.equal(preflightSkill(workflow).status, 'untested')
    assert.ok(preflightSkill(workflow).checks.every((check) => check.state === 'untested'))
    const env: SkillPreflightEnvironment = {
      tools: ['image_gen'],
      executor: 'native',
      agentState: () => 'supported',
      dependencyState: () => 'supported',
    }
    const result = preflightSkill(workflow, env)
    assert.ok(result.checks.every((check) => check.state === 'supported'))
    assert.equal(result.status, 'untested')
    assert.match(skillPreflightNotice(workflow, env), /compatibility is untested/)
    assert.doesNotMatch(skillPreflightNotice(workflow, env), /verified|success/)
  })

  it('does not infer dependencies or requirements from descriptive metadata/prose', () => {
    const result = preflightSkill(
      {
        ...workflow,
        requirements: {},
        dependencies: [],
        compatibility: 'Cursor only; calls task and helper',
        allowedTools: 'Bash',
        metadata: { tools: 'made_up' },
      },
      { tools: [] },
    )
    assert.deepEqual(result, { status: 'untested', checks: [] })
  })
})
