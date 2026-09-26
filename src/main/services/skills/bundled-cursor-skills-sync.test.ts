import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import {
  BUNDLED_CURSOR_PLUGINS_COMMIT,
  assertBundledCursorSkillsSnapshot,
  mentionedSkillFiles,
  syncBundledCursorSkills,
} from '../../../../scripts/bundled-cursor-skills-sync.mts'

const SKILL_BODY =
  '---\nname: demo-skill\ndescription: Demo bundled skill\n---\n\n# Demo\n\n' +
  'Read `references/guide.md`, one of `references/sources/<source>.md`, run `scripts/cli.ts`, ' +
  'and open `playbooks/absent.md`.'

/** Upstream skill files beyond SKILL.md, keyed by skill-relative path. */
const SKILL_FILES: Readonly<Record<string, string>> = {
  'references/guide.md': 'See also references/nested.md.',
  'references/nested.md': '# Nested',
  'references/sources/slack.md': '# Slack',
  'references/unreferenced.md': '# Never named',
  'scripts/cli.ts': 'import { main } from "./cli/index.ts"',
  'scripts/package.json': '{}',
}

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
      if (url.includes('/git/trees/')) {
        const skillPaths = ['SKILL.md', ...Object.keys(SKILL_FILES)].map((path) => ({
          path: `demo-plugin/skills/demo-skill/${path}`,
          type: 'blob',
        }))
        return new Response(JSON.stringify({ truncated: false, tree: skillPaths }), {
          status: 200,
        })
      }
      const skillFilePrefix = '/demo-plugin/skills/demo-skill/'
      const skillFile = url.slice(url.indexOf(skillFilePrefix) + skillFilePrefix.length)
      if (url.includes(skillFilePrefix) && Object.hasOwn(SKILL_FILES, skillFile)) {
        return new Response(SKILL_FILES[skillFile], { status: 200 })
      }
      if (url.endsWith('/demo-plugin/.cursor-plugin/plugin.json')) {
        return new Response(
          JSON.stringify({ name: 'demo-plugin', license: 'MIT', skills: 'skills' }),
          { status: 200 },
        )
      }
      if (url.endsWith('/demo-plugin/skills/demo-skill/SKILL.md')) {
        return new Response(SKILL_BODY, { status: 200 })
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

  it('writes a licensed, content-addressed snapshot', async () => {
    const source = await syncBundledCursorSkills(cacheDir)
    assert.equal(source.skillCount, 1)
    assert.equal(source.skillFiles, 'referenced')
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
    assert.equal(manifest['skillFiles'], 'referenced')
    assert.match(String(manifest['contentSha256']), /^[a-f0-9]{64}$/)
    assert.equal('syncedAt' in manifest, false)
    assert.equal((await assertBundledCursorSkillsSnapshot(cacheDir)).skillCount, 1)
  })

  it('vendors the files a skill names, transitively, and records what stays missing', async () => {
    const source = await syncBundledCursorSkills(cacheDir)
    const skillDir = join(cacheDir, 'plugins', 'demo-plugin', 'skills', 'demo-skill')
    const exists = async (path: string): Promise<boolean> =>
      access(join(skillDir, path)).then(
        () => true,
        () => false,
      )

    assert.equal(await exists('references/guide.md'), true, 'named in SKILL.md')
    assert.equal(await exists('references/nested.md'), true, 'named by a vendored reference')
    assert.equal(await exists('references/sources/slack.md'), true, 'matched by a placeholder')
    assert.equal(await exists('references/unreferenced.md'), false, 'never named')
    assert.equal(await exists('scripts/cli.ts'), false, 'one file of a script project')
    assert.deepEqual(source.danglingReferences, {
      'demo-plugin/demo-skill': ['playbooks/absent.md', 'scripts/cli.ts'],
    })
  })

  it('rejects a snapshot whose missing references drift from SOURCE.json', async () => {
    await syncBundledCursorSkills(cacheDir)
    const sourcePath = join(cacheDir, 'SOURCE.json')
    const manifest = expectRecord(parseJsonUnknown(await readFile(sourcePath, 'utf8')))
    await writeFile(sourcePath, JSON.stringify({ ...manifest, danglingReferences: {} }), 'utf8')
    await assert.rejects(assertBundledCursorSkillsSnapshot(cacheDir), /missing references changed/)
  })

  it('matches literal paths, globs and placeholders, but not unrelated names', () => {
    const candidates = ['references/a.md', 'references/sources/x.md', 'playbooks/b.md']
    assert.deepEqual(mentionedSkillFiles('see references/a.md', candidates), ['references/a.md'])
    assert.deepEqual(mentionedSkillFiles('any references/sources/*.md', candidates), [
      'references/sources/x.md',
    ])
    assert.deepEqual(mentionedSkillFiles('references/<name>.md', candidates), ['references/a.md'])
    assert.deepEqual(mentionedSkillFiles('playbooks/c.md and a.md', candidates), [])
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
