import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  skillMarkdownBody,
  buildSkillsCatalogBlock,
  buildInvokedSkillsBlock,
  buildSkillsToolsPromptLine,
} from './skill-prompt.ts'
import { refreshSkillsRegistry, setSkillsForTest } from './skills-registry.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import type { SkillMetadata } from '@shared/types/skills.ts'

const demoSkill: SkillMetadata = {
  name: 'demo-skill',
  description: 'Demo skill for tests',
  source: 'project',
  skillPath: '/tmp/skills/demo-skill/SKILL.md',
  skillRoot: '/tmp/skills/demo-skill',
  disableModelInvocation: false,
  paths: [],
}

describe('skillMarkdownBody', () => {
  it('strips YAML frontmatter from skill files', () => {
    const raw = `---
name: demo-skill
description: Demo
---

# Instructions`
    assert.equal(skillMarkdownBody(raw), '# Instructions')
  })
})

describe('buildSkillsCatalogBlock', () => {
  it('returns empty string when no skills are registered', () => {
    setSkillsForTest([])
    assert.equal(buildSkillsCatalogBlock(), '')
    assert.equal(buildSkillsToolsPromptLine(), '')
  })

  it('includes read_skill tool line when skills exist', () => {
    setSkillsForTest([demoSkill])
    assert.match(buildSkillsToolsPromptLine(), /read_skill/)
  })

  it('includes agent_skill entries for discovered skills', () => {
    setSkillsForTest([demoSkill])
    const block = buildSkillsCatalogBlock()
    assert.match(block, /<available_skills>/)
    assert.match(block, /demo-skill/)
    assert.match(block, /Demo skill for tests/)
  })
})

describe('buildInvokedSkillsBlock', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-skill-prompt-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await mkdir(join(tempRoot, '.cursor', 'skills', 'demo-skill'), { recursive: true })
    await writeFile(
      join(tempRoot, '.cursor', 'skills', 'demo-skill', 'SKILL.md'),
      `---
name: demo-skill
description: Demo skill for tests
---

# Demo instructions`,
      'utf-8',
    )
    await refreshSkillsRegistry()
  })

  afterEach(async () => {
    restoreWorkspace?.()
    setSkillsForTest([])
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('returns empty string when no skills were invoked', async () => {
    assert.equal(await buildInvokedSkillsBlock([]), '')
  })

  it('injects tier-2 skill body without frontmatter', async () => {
    const block = await buildInvokedSkillsBlock(['demo-skill'])
    assert.match(block, /<skill_content name="demo-skill">/)
    assert.match(block, /# Demo instructions/)
    assert.doesNotMatch(block, /description: Demo skill for tests/)
  })

  it('reports missing skills without throwing', async () => {
    const block = await buildInvokedSkillsBlock(['missing-skill'])
    assert.match(block, /failed to load skill/)
  })
})
