import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  refreshSkillsRegistry,
  listSkills,
  readSkill,
  getSkill,
  setSkillsForTest,
  SKILL_READ_MAX_BYTES,
} from './skills-registry.ts'
import { setSetting } from './settings.test-shim.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import {
  resetBundledCursorSkillsRootForTest,
  setBundledCursorSkillsRootForTest,
} from './bundled-cursor-skills.ts'

describe('skills-registry', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSkillsForTest([])
    setSetting('skillsEnabled', true)
    setSetting('skillPluginPaths', [])
    setSetting('bundledCursorSkillsEnabled', false)
    setBundledCursorSkillsRootForTest(null)
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
    resetBundledCursorSkillsRootForTest()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('discovers project skills under .cursor/skills', async () => {
    await refreshSkillsRegistry()
    const skills = listSkills()
    const demo = skills.find((skill) => skill.name === 'demo-skill' && skill.source === 'project')
    assert.ok(demo, 'expected demo-skill from project .cursor/skills')
  })

  it('discovers bundled Cursor skills when enabled', async () => {
    const bundledRoot = await mkdtemp(join(tmpdir(), 'copse-bundled-registry-'))
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

    setSetting('bundledCursorSkillsEnabled', true)
    setBundledCursorSkillsRootForTest(bundledRoot)
    await refreshSkillsRegistry()
    const skill = listSkills().find((s) => s.name === 'bundled-skill')
    assert.ok(skill)
    assert.equal(skill?.source, 'bundled')

    await rm(bundledRoot, { recursive: true, force: true })
  })

  it('omits bundled skills when bundledCursorSkillsEnabled is false', async () => {
    setBundledCursorSkillsRootForTest(join(process.cwd(), 'vendor/bundled-cursor-skills'))
    setSetting('bundledCursorSkillsEnabled', false)
    await refreshSkillsRegistry()
    assert.equal(
      listSkills().some((skill) => skill.source === 'bundled'),
      false,
    )
  })

  it('reads skill content by name', async () => {
    await refreshSkillsRegistry()
    const result = await readSkill('demo-skill')
    assert.match(result.body, /# Demo/)
    assert.equal(result.relativePath, 'SKILL.md')
  })

  it('rejects symlink escape outside skill root', async () => {
    await refreshSkillsRegistry()
    const demo = getSkill('demo-skill')
    assert.ok(demo)
    const outside = await mkdtemp(join(tmpdir(), 'copse-skill-out-'))
    await writeFile(join(outside, 'leak.txt'), 'leak', 'utf8')
    await symlink(join(outside, 'leak.txt'), join(demo!.skillRoot, 'link.txt'))
    try {
      await assert.rejects(() => readSkill('demo-skill', 'link.txt'), /outside skill root/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects skill files over the size cap', async () => {
    await refreshSkillsRegistry()
    const skillRoot = join(tempRoot, '.cursor', 'skills', 'demo-skill')
    await writeFile(join(skillRoot, 'big.bin'), 'x'.repeat(SKILL_READ_MAX_BYTES + 1), 'utf8')
    await assert.rejects(() => readSkill('demo-skill', 'big.bin'), /too large/)
  })
})
