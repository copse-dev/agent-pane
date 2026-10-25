import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setSetting } from '../storage/settings.test-shim.ts'
import {
  getBundledCursorSkillsRoot,
  isBundledSkillPluginEnabled,
  listBundledCursorPluginRoots,
  listBundledSkillPlugins,
  resetBundledCursorSkillsRootForTest,
  setBundledCursorSkillsRootForTest,
} from './bundled-cursor-skills.ts'

describe('bundled-cursor-skills', () => {
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-bundled-skills-'))
  })

  afterEach(async () => {
    setSetting('bundledCursorSkillsEnabled', true)
    setSetting('bundledSkillPluginOverrides', {})
    resetBundledCursorSkillsRootForTest()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('returns null when no bundled tree exists', async () => {
    setBundledCursorSkillsRootForTest(null)
    assert.equal(getBundledCursorSkillsRoot(), null)
    assert.deepEqual(await listBundledCursorPluginRoots(), [])
  })

  it('lists plugin roots that expose skills/', async () => {
    const pluginRoot = join(tempRoot, 'plugins', 'demo-plugin')
    await mkdir(join(pluginRoot, '.cursor-plugin'), { recursive: true })
    await mkdir(join(pluginRoot, 'skills', 'demo-skill'), { recursive: true })
    await writeFile(
      join(pluginRoot, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin', skills: 'skills' }),
      'utf8',
    )
    await writeFile(
      join(pluginRoot, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo\n---\n',
      'utf8',
    )

    setBundledCursorSkillsRootForTest(tempRoot)
    const roots = await listBundledCursorPluginRoots()
    assert.equal(roots.length, 1)
    assert.equal(roots[0], pluginRoot)
  })

  describe('per-plugin switches', () => {
    async function seedPlugin(name: string, skills: readonly string[]): Promise<void> {
      const pluginRoot = join(tempRoot, 'plugins', name)
      await mkdir(join(pluginRoot, '.cursor-plugin'), { recursive: true })
      await writeFile(
        join(pluginRoot, '.cursor-plugin', 'plugin.json'),
        JSON.stringify({ name, description: `${name} skills`, version: '1.2.3' }),
        'utf8',
      )
      for (const skill of skills) {
        await mkdir(join(pluginRoot, 'skills', skill), { recursive: true })
        await writeFile(
          join(pluginRoot, 'skills', skill, 'SKILL.md'),
          `---\nname: ${skill}\ndescription: ${skill}\n---\n`,
          'utf8',
        )
      }
    }

    beforeEach(async () => {
      await seedPlugin('teaching', ['how', 'why'])
      await seedPlugin('cursor-team-kit', ['fix-ci'])
      setBundledCursorSkillsRootForTest(tempRoot)
    })

    it('enables bundled plugins by default', async () => {
      assert.equal(isBundledSkillPluginEnabled('teaching'), true)
      assert.equal(isBundledSkillPluginEnabled('cursor-team-kit'), true)
      const [teamKit, teaching] = await listBundledSkillPlugins()
      assert.deepEqual(teamKit, {
        name: 'cursor-team-kit',
        description: 'cursor-team-kit skills',
        version: '1.2.3',
        skillCount: 1,
        enabled: true,
        defaultEnabled: true,
        suppressed: false,
      })
      assert.ok(teaching)
      assert.equal(teaching.enabled, true)
      assert.equal(teaching.defaultEnabled, true)
      assert.equal(teaching.skillCount, 2)
      assert.equal(teaching.offByDefaultReason, undefined)
    })

    it("follows the user's choice over the default", async () => {
      setSetting('bundledSkillPluginOverrides', { teaching: true, 'cursor-team-kit': false })
      assert.equal(isBundledSkillPluginEnabled('teaching'), true)
      assert.equal(isBundledSkillPluginEnabled('cursor-team-kit'), false)
      const summaries = await listBundledSkillPlugins()
      assert.deepEqual(
        summaries.map(({ name, enabled }) => ({ name, enabled })),
        [
          { name: 'cursor-team-kit', enabled: false },
          { name: 'teaching', enabled: true },
        ],
      )
    })

    it('marks every plugin suppressed while all bundled skills are off', async () => {
      setSetting('bundledCursorSkillsEnabled', false)
      const summaries = await listBundledSkillPlugins()
      assert.ok(summaries.every((summary) => summary.suppressed))
    })
  })
})
