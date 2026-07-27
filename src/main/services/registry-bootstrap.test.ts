import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createRegistry,
  registerSkillTools,
  syncGhTools,
  syncOkfMemoryTools,
  syncReadTerminalTools,
  syncRoadmapPlanTools,
} from './registry-bootstrap.ts'
import { ToolRegistry } from './tool-registry.ts'
import { refreshSkillsRegistry, setSkillsForTest } from './skills/skills-registry.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { setSetting } from './storage/settings.test-shim.ts'
import { setGhAvailableForTest } from './tool-availability.ts'
import { setDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
import { ROADMAP_PLANS_PACK_ID } from '@copse/agent/packs/roadmap-plans-pack.ts'
import {
  setBundledCursorSkillsRootForTest,
  resetBundledCursorSkillsRootForTest,
} from './skills/bundled-cursor-skills.ts'
import { OKF_MEMORIES_PACK_ID } from '@copse/agent/packs/okf-memories-pack.ts'

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

  // Startup builds the registry *before* awaiting `checkToolAvailability()`, so
  // the IPC handlers can register without sitting behind ~9 process spawns (the
  // renderer invokes settings/ssh channels on first paint). At that point the
  // probe has not answered and `isGhAvailable()` reads false, so #523's
  // invariant rests entirely on this second sync — without it the GitHub tools
  // would stay hidden for the whole session on every launch.
  it('exposes the read-only GitHub tools when the probe answers after createRegistry', () => {
    setGhAvailableForTest(null) // probe still in flight
    const registry = createRegistry()
    for (const name of GH_READONLY_TOOLS) {
      assert.equal(registry.has(name), false, `expected ${name} to be absent pre-probe`)
    }

    setGhAvailableForTest(true) // probe resolves
    syncGhTools(registry)
    for (const name of GH_READONLY_TOOLS) {
      assert.equal(registry.has(name), true, `expected ${name} to appear post-probe`)
    }
  })

  it('is idempotent and reversible', () => {
    setGhAvailableForTest(true)
    const registry = createRegistry()
    syncGhTools(registry)
    syncGhTools(registry)
    for (const name of GH_READONLY_TOOLS) {
      assert.equal(registry.has(name), true, `expected ${name} to survive a repeat sync`)
    }

    setGhAvailableForTest(false)
    syncGhTools(registry)
    for (const name of GH_READONLY_TOOLS) {
      assert.equal(registry.has(name), false, `expected ${name} to be dropped`)
    }
    assert.equal(registry.has('run_shell'), true)
  })
})

describe('syncOkfMemoryTools', () => {
  afterEach(() => {
    // Restore the fresh first-party-seed fallback for other suites.
    setDefaultPackRegistry(null)
  })

  it('adds the memory tools when the pack is enabled and removes them when disabled', () => {
    const registry = new ToolRegistry()
    // Drive the sync through the shared pack registry the host reads: the
    // `copse.okf-memories` pack is now the master switch (its old
    // `okfMemoriesEnabled` setting is retired).
    const packs = createFirstPartyPackRegistry()
    setDefaultPackRegistry(packs)

    packs.disable(OKF_MEMORIES_PACK_ID)
    syncOkfMemoryTools(registry)
    assert.equal(registry.has('remember'), false)
    assert.equal(registry.has('recall'), false)

    packs.enable(OKF_MEMORIES_PACK_ID)
    syncOkfMemoryTools(registry)
    assert.equal(registry.has('remember'), true)
    assert.equal(registry.has('recall'), true)

    // Idempotent while enabled — a second sync keeps the tools registered.
    syncOkfMemoryTools(registry)
    assert.equal(registry.has('remember'), true)

    packs.disable(OKF_MEMORIES_PACK_ID)
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
  // Roadmap plans are now gated by the `copse.roadmap-plans` first-party pack,
  // so drive enablement through the shared pack registry (not the retired
  // `roadmapPlansEnabled` setting). Install a fresh first-party registry per
  // test and restore the fallback afterwards.
  afterEach(() => {
    setDefaultPackRegistry(null)
  })

  it('adds the roadmap tool when the pack is enabled and removes it when disabled', () => {
    const packRegistry = createFirstPartyPackRegistry()
    setDefaultPackRegistry(packRegistry)
    const registry = new ToolRegistry()

    packRegistry.disable(ROADMAP_PLANS_PACK_ID)
    syncRoadmapPlanTools(registry)
    assert.equal(registry.has('roadmap_plan'), false)

    packRegistry.enable(ROADMAP_PLANS_PACK_ID)
    syncRoadmapPlanTools(registry)
    assert.equal(registry.has('roadmap_plan'), true)

    // Idempotent while enabled — a second sync keeps the tool registered.
    syncRoadmapPlanTools(registry)
    assert.equal(registry.has('roadmap_plan'), true)

    packRegistry.disable(ROADMAP_PLANS_PACK_ID)
    syncRoadmapPlanTools(registry)
    assert.equal(registry.has('roadmap_plan'), false)
  })
})
