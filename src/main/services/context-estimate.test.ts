import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { estimateContextBreakdown } from './context-estimate.ts'
import { createRegistry, registerSkillTools } from './registry-bootstrap.ts'
import { REQUEST_WRITE_ACCESS_TOOL } from '@shared/tools/readonly-tools.ts'
import { CHARS_PER_TOKEN } from '@copse/agent/token-estimate.ts'
import { refreshSkillsRegistry } from './skills/skills-registry.ts'
import { setSetting } from './storage/settings.test-shim.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import {
  resetBundledCursorSkillsRootForTest,
  setBundledCursorSkillsRootForTest,
} from './skills/bundled-cursor-skills.ts'

function skillsTokens(breakdown: Awaited<ReturnType<typeof estimateContextBreakdown>>): number {
  return breakdown.segments.find((segment) => segment.key === 'skills')?.tokens ?? 0
}

function toolsTokens(breakdown: Awaited<ReturnType<typeof estimateContextBreakdown>>): number {
  return breakdown.segments.find((segment) => segment.key === 'tools')?.tokens ?? 0
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
    const registry = createRegistry()
    registerSkillTools(registry)
    const withBundled = await estimateContextBreakdown(registry, {
      draftText: '',
      invokedSkills: [],
      imageCount: 0,
      priorMessages: [],
    })

    setSetting('bundledCursorSkillsEnabled', false)
    await refreshSkillsRegistry()
    registerSkillTools(registry)
    const withoutBundled = await estimateContextBreakdown(registry, {
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

  it('counts request_write_access only for a deferred thread, which is the only one offered it', async () => {
    const registry = createRegistry()
    const tool = registry
      .toLLMTools()
      .find((candidate) => candidate.name === REQUEST_WRITE_ACCESS_TOOL)
    assert.ok(tool, 'the registry should hold request_write_access')
    const toolTokens =
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length / CHARS_PER_TOKEN
    const input = { draftText: '', invokedSkills: [], imageCount: 0, priorMessages: [] }

    const ordinary = await estimateContextBreakdown(registry, input)
    const deferred = await estimateContextBreakdown(registry, { ...input, deferredWorktree: true })

    // Segments are rounded independently, so allow one token either way.
    assert.ok(
      Math.abs(toolsTokens(deferred) - toolsTokens(ordinary) - toolTokens) <= 1,
      `only a deferred thread should count the ~${String(Math.round(toolTokens))}-token tool`,
    )
  })

  it('omits model skill context when the offered toolset cannot activate skills', async () => {
    await refreshSkillsRegistry()
    const breakdown = await estimateContextBreakdown(createRegistry(), {
      draftText: '',
      invokedSkills: [],
      imageCount: 0,
      priorMessages: [],
    })
    assert.equal(skillsTokens(breakdown), 0)
  })
})
