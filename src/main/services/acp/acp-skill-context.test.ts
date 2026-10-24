import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillMetadata } from '@shared/types/skills.ts'
import { setSkillsForTest, skillPreflightEnvironment } from '../skills/skills-registry.ts'
import { buildInvokedSkillsBlock } from '../skills/skill-prompt.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAcpSkillRun } from './acp-skill-context.ts'
import { MAX_MODEL_SKILL_CONTEXT_BYTES } from '../skills/skill-activation.ts'

describe('ACP skill execution context', () => {
  it('inlines invoked skills with a notice when no read_skill bridge was negotiated', () => {
    for (const toolNames of [[], ['read_file']]) {
      const { prompt } = createAcpSkillRun()({
        toolNames,
        invokedSkills: ['tiny'],
        skillsBlock: 'INSTRUCTIONS',
        includeCatalog: true,
      })
      assert.match(prompt, /cannot reach Copse’s read_skill tool/)
      assert.match(prompt, /supporting files and model-selected skills are unavailable/)
      // Explicit instructions stay last, and no catalog is advertised without read_skill.
      assert.ok(prompt.endsWith('INSTRUCTIONS'))
      assert.doesNotMatch(prompt, /agent_skill/)
    }
    assert.doesNotMatch(
      createAcpSkillRun()({
        toolNames: ['read_skill'],
        invokedSkills: ['tiny'],
        skillsBlock: 'INSTRUCTIONS',
        includeCatalog: false,
      }).prompt,
      /cannot reach Copse’s read_skill tool/,
    )
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
  it('replays already-charged instructions after fresh-session handover without resetting budgets or replaying removed skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-skill-replay-'))
    const skills: SkillMetadata[] = []
    try {
      for (const name of ['manual', 'automatic']) {
        const skillRoot = join(root, name)
        await mkdir(skillRoot)
        await writeFile(
          join(skillRoot, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Workflow\n---\n${name}-instructions`,
        )
        for (const file of ['reference.md', 'second.md', 'third.md'])
          await writeFile(join(skillRoot, file), 'SUPPORT-CONTEXT ' + 'x'.repeat(45_000))
        skills.push({
          name,
          description: 'Workflow',
          source: 'project',
          skillRoot,
          skillPath: join(skillRoot, 'SKILL.md'),
          disableModelInvocation: name === 'manual',
          paths: [],
          externalLinks: [],
          missingReferences: [],
        })
      }
      setSkillsForTest(skills)
      const toolNames = ['read_skill']
      const skillsBlock = await buildInvokedSkillsBlock(['manual'], {
        preflight: skillPreflightEnvironment(toolNames, 'acp'),
      })
      const prepare = createAcpSkillRun()
      const first = prepare({
        toolNames,
        invokedSkills: ['manual'],
        skillsBlock,
        includeCatalog: true,
        freshSession: true,
      })
      const signal = new AbortController().signal
      await first.activation.read('automatic', undefined, signal)
      await first.activation.read('automatic', 'reference.md', signal)
      await first.activation.read('automatic', 'second.md', signal)
      await first.activation.read('automatic', undefined, signal)
      const continuation = { toolNames, invokedSkills: [], skillsBlock: '', includeCatalog: true }
      assert.ok(!prepare(continuation).prompt.includes('SUPPORT-CONTEXT'))
      const fresh = prepare({ ...continuation, freshSession: true })
      assert.equal(fresh.activation, first.activation)
      for (const marker of ['manual-instructions', 'automatic-instructions', 'SUPPORT-CONTEXT']) {
        assert.ok(fresh.prompt.includes(marker), `lost ${marker} during handover`)
      }
      assert.ok(!fresh.prompt.includes('already active in this turn'))
      assert.ok(
        fresh.prompt.indexOf('manual-instructions') > fresh.prompt.indexOf('SUPPORT-CONTEXT'),
      )
      await assert.rejects(fresh.activation.read('automatic', 'third.md', signal), /context limit/)
      setSkillsForTest(
        skills.map((skill) => (skill.name === 'automatic' ? { ...skill, source: 'user' } : skill)),
      )
      const replaced = prepare({ ...continuation, freshSession: true }).prompt
      assert.ok(!replaced.includes('SUPPORT-CONTEXT'))
      assert.ok(replaced.includes('manual-instructions'))
      setSkillsForTest(
        skills.map((skill) =>
          skill.name === 'automatic'
            ? { ...skill, requirements: { executors: ['native'] } }
            : skill,
        ),
      )
      assert.ok(
        !prepare({ ...continuation, freshSession: true }).prompt.includes('SUPPORT-CONTEXT'),
      )
      setSkillsForTest([])
      const removed = prepare({ ...continuation, freshSession: true, skillsBlock }).prompt
      assert.ok(!removed.includes('manual-instructions') && !removed.includes('SUPPORT-CONTEXT'))
    } finally {
      setSkillsForTest([])
      await rm(root, { recursive: true, force: true })
    }
  })
})
