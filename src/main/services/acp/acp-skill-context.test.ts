import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAcpSkillRun } from './acp-skill-context.ts'
import { MAX_MODEL_SKILL_CONTEXT_BYTES } from '../skills/skill-activation.ts'

describe('ACP skill execution context', () => {
  it('fails clearly for invoked skills without a negotiated read_skill bridge', () => {
    for (const toolNames of [[], ['read_file']]) {
      assert.throws(
        () =>
          createAcpSkillRun()({
            toolNames,
            invokedSkills: ['tiny'],
            skillsBlock: 'instructions',
            includeCatalog: true,
          }),
        /local agent that supports HTTP MCP/,
      )
    }
    assert.equal(
      createAcpSkillRun()({
        toolNames: [],
        invokedSkills: [],
        skillsBlock: '',
        includeCatalog: true,
      }).prompt,
      '',
    )
  })

  it('rejects oversized invoked UTF-8 context rather than sending it to the external agent', () => {
    assert.throws(
      () =>
        createAcpSkillRun()({
          toolNames: ['read_skill'],
          invokedSkills: ['tiny'],
          skillsBlock: '🦉'.repeat(MAX_MODEL_SKILL_CONTEXT_BYTES / 4 + 1),
          includeCatalog: true,
        }),
      /skill-context budget/,
    )
  })

  it('retains explicit instructions last and allocates distinct allowances per run', () => {
    const options = {
      toolNames: ['read_skill'],
      invokedSkills: [],
      skillsBlock: 'EXPLICIT',
      includeCatalog: false,
    }
    const prepare = createAcpSkillRun()
    const first = prepare(options)
    const continuation = prepare({ ...options, skillsBlock: '' })
    assert.equal(continuation.activation, first.activation)
    const second = createAcpSkillRun()(options)
    assert.equal(first.prompt, 'EXPLICIT')
    assert.notEqual(first.activation, second.activation)
  })
})
