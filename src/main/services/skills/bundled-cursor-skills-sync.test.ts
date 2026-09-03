import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import {
  BUNDLED_CURSOR_PLUGINS_COMMIT,
  assertBundledCursorSkillsSnapshot,
  syncBundledCursorSkills,
} from '../../../../scripts/bundled-cursor-skills-sync.mts'

describe('bundled-cursor-skills-sync', () => {
  let cacheDir = ''
  let fetchMock: ReturnType<typeof mock.fn>

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'copse-bundled-sync-'))
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
        return new Response(
          JSON.stringify({ name: 'demo-plugin', license: 'MIT', skills: 'skills' }),
          { status: 200 },
        )
      }
      if (url.endsWith('/demo-plugin/skills/demo-skill/SKILL.md')) {
        return new Response(
          '---\nname: demo-skill\ndescription: Demo bundled skill\n---\n\n# Demo',
          { status: 200 },
        )
      }
      if (url.endsWith('/demo-plugin/LICENSE')) {
        return new Response('MIT License\n\nCopyright Cursor', { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })
    mock.method(globalThis, 'fetch', fetchMock)
  })

  afterEach(async () => {
    mock.restoreAll()
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
  })

  it('writes a slim, licensed, content-addressed snapshot', async () => {
    const source = await syncBundledCursorSkills(cacheDir)
    assert.equal(source.skillCount, 1)
    assert.equal(source.slim, true)
    assert.equal(source.commit, BUNDLED_CURSOR_PLUGINS_COMMIT)

    const skillBody = await readFile(
      join(cacheDir, 'plugins', 'demo-plugin', 'skills', 'demo-skill', 'SKILL.md'),
      'utf8',
    )
    assert.match(skillBody, /# Demo/)
    assert.match(
      await readFile(join(cacheDir, 'plugins', 'demo-plugin', 'LICENSE'), 'utf8'),
      /MIT License/,
    )

    const manifest = expectRecord(
      parseJsonUnknown(await readFile(join(cacheDir, 'SOURCE.json'), 'utf8')),
    )
    assert.equal(manifest['slim'], true)
    assert.match(String(manifest['contentSha256']), /^[a-f0-9]{64}$/)
    assert.equal('syncedAt' in manifest, false)
    assert.equal((await assertBundledCursorSkillsSnapshot(cacheDir)).skillCount, 1)
  })

  it('rejects a modified vendored skill', async () => {
    await syncBundledCursorSkills(cacheDir)
    await writeFile(
      join(cacheDir, 'plugins', 'demo-plugin', 'skills', 'demo-skill', 'SKILL.md'),
      '# modified after sync',
      'utf8',
    )
    await assert.rejects(assertBundledCursorSkillsSnapshot(cacheDir), /content hash mismatch/)
  })
})
