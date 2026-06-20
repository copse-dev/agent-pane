import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRegistry, registerSkillTools } from './registry-bootstrap.ts'
import { refreshSkillsRegistry, setSkillsForTest } from './skills-registry.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('registerSkillTools', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'agent-pane-registry-'))
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
    setSkillsForTest([])
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('registers read_skill after skills are discovered', async () => {
    const registry = createRegistry()
    assert.equal(registry.has('read_skill'), false)

    await refreshSkillsRegistry()
    registerSkillTools(registry)

    assert.equal(registry.has('read_skill'), true)
  })
})
