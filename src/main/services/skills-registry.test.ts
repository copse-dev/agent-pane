import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  refreshSkillsRegistry,
  listSkills,
  readSkill,
  setSkillsForTest,
} from './skills-registry.ts'
import { setSetting } from './settings.test-shim.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('skills-registry', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSkillsForTest([])
    setSetting('skillsEnabled', true)
    setSetting('skillPluginPaths', [])
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-skills-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    await mkdir(join(tempRoot, '.cursor', 'skills', 'demo-skill'), { recursive: true })
    await writeFile(
      join(tempRoot, '.cursor', 'skills', 'demo-skill', 'SKILL.md'),
      `---
name: demo-skill
description: Demo skill for tests
---

# Demo`,
      'utf-8',
    )
  })

  afterEach(async () => {
    restoreWorkspace?.()
    restoreWorkspace = undefined
    setSkillsForTest([])
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('discovers project skills under .cursor/skills', async () => {
    await refreshSkillsRegistry()
    const skills = listSkills()
    const demo = skills.find((skill) => skill.name === 'demo-skill' && skill.source === 'project')
    assert.ok(demo, 'expected demo-skill from project .cursor/skills')
  })

  it('reads skill content by name', async () => {
    await refreshSkillsRegistry()
    const result = await readSkill('demo-skill')
    assert.match(result.body, /# Demo/)
    assert.equal(result.relativePath, 'SKILL.md')
  })
})
