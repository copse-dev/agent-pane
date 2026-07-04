import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { estimateContextBreakdown } from './context-estimate.ts'
import { createRegistry } from './registry-bootstrap.ts'
import { refreshSkillsRegistry } from './skills-registry.ts'
import { setSetting } from './storage/settings.test-shim.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import {
  resetBundledCursorSkillsRootForTest,
  setBundledCursorSkillsRootForTest,
} from './bundled-cursor-skills.ts'

function skillsTokens(breakdown: Awaited<ReturnType<typeof estimateContextBreakdown>>): number {
  return breakdown.segments.find((segment) => segment.key === 'skills')?.tokens ?? 0
}

describe('estimateContextBreakdown', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSetting('skillsEnabled', true)
    setSetting('skillPluginPaths', [])
    setSetting('subagentsEnabled', false)
    setSetting('model', 'claude-sonnet-4-6')
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-context-estimate-'))
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
    resetBundledCursorSkillsRootForTest()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('includes bundled skills in the skills segment when enabled', async () => {
    const bundledRoot = await mkdtemp(join(tmpdir(), 'copse-bundled-estimate-'))
    const pluginRoot = join(bundledRoot, 'plugins', 'demo-plugin')
    await mkdir(join(pluginRoot, '.cursor-plugin'), { recursive: true })
    await mkdir(join(pluginRoot, 'skills', 'bundled-skill'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin', skills: 'skills' }),
      'utf8',
    )
    await writeFile(
      join(pluginRoot, 'skills', 'bundled-skill', 'SKILL.md'),
      `---
name: bundled-skill
description: Bundled skill for tests
---

# Bundled`,
      'utf-8',
    )

    setBundledCursorSkillsRootForTest(bundledRoot)
    setSetting('bundledCursorSkillsEnabled', true)
    await refreshSkillsRegistry()
    const withBundled = await estimateContextBreakdown(createRegistry(), {
      draftText: '',
      invokedSkills: [],
      imageCount: 0,
      priorMessages: [],
    })

    setSetting('bundledCursorSkillsEnabled', false)
    await refreshSkillsRegistry()
    const withoutBundled = await estimateContextBreakdown(createRegistry(), {
      draftText: '',
      invokedSkills: [],
      imageCount: 0,
      priorMessages: [],
    })

    assert.ok(
      skillsTokens(withBundled) > skillsTokens(withoutBundled),
      'disabling bundled skills should shrink the skills segment',
    )

    await rm(bundledRoot, { recursive: true, force: true })
  })
})
