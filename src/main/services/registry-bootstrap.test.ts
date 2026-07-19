import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createRegistry,
  registerSkillTools,
  syncOkfMemoryTools,
  syncReadTerminalTools,
  syncRoadmapPlanTools,
} from './registry-bootstrap.ts'
import { ToolRegistry } from './tool-registry.ts'
import { refreshSkillsRegistry, setSkillsForTest } from './skills/skills-registry.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { setSetting } from './storage/settings.test-shim.ts'
import { setGhAvailableForTest } from './tool-availability.ts'
import {
  setBundledCursorSkillsRootForTest,
  resetBundledCursorSkillsRootForTest,
} from './skills/bundled-cursor-skills.ts'

describe('registerSkillTools', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSetting('bundledCursorSkillsEnabled', false)
    setBundledCursorSkillsRootForTest(null)
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-registry-'))
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
    resetBundledCursorSkillsRootForTest()
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

describe('createRegistry GitHub tool gating', () => {
  const GH_READONLY_TOOLS = [
    'gh_pr_list',
    'gh_pr_view',
    'gh_pr_files',
    'get_ci_status',
    'wait_for_ci_checks',
    'get_ci_failure_logs',
  ]

  afterEach(() => {
    setGhAvailableForTest(null)
  })

  it('registers the read-only GitHub tools when gh is accessible', () => {
    setGhAvailableForTest(true)
    const registry = createRegistry()
    for (const name of GH_READONLY_TOOLS) {
      assert.equal(registry.has(name), true, `expected ${name} to be registered`)
    }
  })

  it('omits the read-only GitHub tools when gh is not accessible', () => {
    setGhAvailableForTest(false)
    const registry = createRegistry()
    for (const name of GH_READONLY_TOOLS) {
      assert.equal(registry.has(name), false, `expected ${name} to be omitted`)
    }
    // Non-GitHub tools are still exposed regardless of gh availability.
    assert.equal(registry.has('run_shell'), true)
  })
})

describe('syncOkfMemoryTools', () => {
  afterEach(() => {
    setSetting('okfMemoriesEnabled', false)
  })

  it('adds the memory tools when enabled and removes them when disabled', () => {
    const registry = new ToolRegistry()

    setSetting('okfMemoriesEnabled', false)
    syncOkfMemoryTools(registry)
    assert.equal(registry.has('remember'), false)
    assert.equal(registry.has('recall'), false)

    setSetting('okfMemoriesEnabled', true)
    syncOkfMemoryTools(registry)
    assert.equal(registry.has('remember'), true)
    assert.equal(registry.has('recall'), true)

    // Idempotent while enabled — a second sync keeps the tools registered.
    syncOkfMemoryTools(registry)
    assert.equal(registry.has('remember'), true)

    setSetting('okfMemoriesEnabled', false)
    syncOkfMemoryTools(registry)
    assert.equal(registry.has('remember'), false)
    assert.equal(registry.has('recall'), false)
  })
})

describe('syncReadTerminalTools', () => {
  afterEach(() => {
    setSetting('readTerminalEnabled', true)
  })

  it('registers by default and removes when disabled', () => {
    const registry = new ToolRegistry()

    setSetting('readTerminalEnabled', true)
    syncReadTerminalTools(registry)
    assert.equal(registry.has('read_terminal'), true)

    setSetting('readTerminalEnabled', false)
    syncReadTerminalTools(registry)
    assert.equal(registry.has('read_terminal'), false)

    setSetting('readTerminalEnabled', true)
    syncReadTerminalTools(registry)
    assert.equal(registry.has('read_terminal'), true)
  })
})

describe('syncRoadmapPlanTools', () => {
  afterEach(() => {
    setSetting('roadmapPlansEnabled', false)
  })

  it('adds the roadmap tool when enabled and removes it when disabled', () => {
    const registry = new ToolRegistry()

    setSetting('roadmapPlansEnabled', false)
    syncRoadmapPlanTools(registry)
    assert.equal(registry.has('roadmap_plan'), false)

    setSetting('roadmapPlansEnabled', true)
    syncRoadmapPlanTools(registry)
    assert.equal(registry.has('roadmap_plan'), true)

    // Idempotent while enabled — a second sync keeps the tool registered.
    syncRoadmapPlanTools(registry)
    assert.equal(registry.has('roadmap_plan'), true)

    setSetting('roadmapPlansEnabled', false)
    syncRoadmapPlanTools(registry)
    assert.equal(registry.has('roadmap_plan'), false)
  })
})
