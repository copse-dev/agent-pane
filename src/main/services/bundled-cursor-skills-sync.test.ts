import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BUNDLED_CURSOR_PLUGINS_COMMIT,
  resetBundledCursorSkillsSyncForTest,
  syncBundledCursorSkills,
} from './bundled-cursor-skills-sync.ts'

describe('bundled-cursor-skills-sync', () => {
  let cacheDir = ''
  let fetchMock: ReturnType<typeof mock.fn>

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'copse-bundled-sync-'))
    resetBundledCursorSkillsSyncForTest()
    fetchMock = mock.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/marketplace.json')) {
        return new Response(
          JSON.stringify({
            plugins: [{ name: 'demo-plugin', source: 'demo-plugin' }],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/contents/demo-plugin/skills?')) {
        return new Response(JSON.stringify([{ name: 'demo-skill', type: 'dir' }]), {
          status: 200,
        })
      }
      if (url.endsWith('/demo-plugin/.cursor-plugin/plugin.json')) {
        return new Response(JSON.stringify({ name: 'demo-plugin', skills: 'skills' }), {
          status: 200,
        })
      }
      if (url.endsWith('/demo-plugin/skills/demo-skill/SKILL.md')) {
        return new Response(
          '---\nname: demo-skill\ndescription: Demo bundled skill\n---\n\n# Demo',
          { status: 200 },
        )
      }
      return new Response('not found', { status: 404 })
    })
    mock.method(globalThis, 'fetch', fetchMock)
  })

  afterEach(async () => {
    mock.restoreAll()
    resetBundledCursorSkillsSyncForTest()
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
  })

  it('writes slim SKILL.md cache and SOURCE.json', async () => {
    const source = await syncBundledCursorSkills(cacheDir)
    assert.equal(source.skillCount, 1)
    assert.equal(source.slim, true)
    assert.equal(source.commit, BUNDLED_CURSOR_PLUGINS_COMMIT)

    const skillBody = await readFile(
      join(cacheDir, 'plugins', 'demo-plugin', 'skills', 'demo-skill', 'SKILL.md'),
      'utf8',
    )
    assert.match(skillBody, /# Demo/)

    const manifest = JSON.parse(await readFile(join(cacheDir, 'SOURCE.json'), 'utf8')) as {
      slim: boolean
    }
    assert.equal(manifest.slim, true)
  })
})
