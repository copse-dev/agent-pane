import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getBundledCursorSkillsRoot,
  listBundledCursorPluginRoots,
  resetBundledCursorSkillsRootForTest,
  setBundledCursorSkillsRootForTest,
} from './bundled-cursor-skills.ts'

describe('bundled-cursor-skills', () => {
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-bundled-skills-'))
  })

  afterEach(async () => {
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
})
