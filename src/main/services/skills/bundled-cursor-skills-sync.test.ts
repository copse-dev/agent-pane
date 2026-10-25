import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import {
  BUNDLED_CURSOR_PLUGINS_COMMIT,
  assertBundledCursorSkillsSnapshot,
  mentionedSkillFiles,
  syncBundledCursorSkills,
  refreshBundledSkillReferences,
  findDanglingSkillReferences,
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
  'package.json': '{}',
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
            plugins: [
              { name: 'cursor-team-kit', source: 'cursor-team-kit' },
              { name: 'pstack', source: 'pstack' },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('/git/trees/')) {
        const skillPaths = ['SKILL.md', ...Object.keys(SKILL_FILES)].map((path) => ({
          path: `cursor-team-kit/skills/demo-skill/${path}`,
          type: 'blob',
        }))
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [...skillPaths, { path: 'pstack/skills/poteto-mode/SKILL.md', type: 'blob' }],
          }),
          {
            status: 200,
          },
        )
      }
      const skillFilePrefix = '/cursor-team-kit/skills/demo-skill/'
      const skillFile = url.slice(url.indexOf(skillFilePrefix) + skillFilePrefix.length)
      if (url.includes(skillFilePrefix) && Object.hasOwn(SKILL_FILES, skillFile)) {
        return new Response(SKILL_FILES[skillFile], { status: 200 })
      }
      if (url.endsWith('/cursor-team-kit/.cursor-plugin/plugin.json')) {
        return new Response(
          JSON.stringify({ name: 'cursor-team-kit', license: 'MIT', skills: 'skills' }),
          { status: 200 },
        )
      }
      if (url.endsWith('/cursor-team-kit/skills/demo-skill/SKILL.md')) {
        return new Response(SKILL_BODY, { status: 200 })
      }
      if (url.endsWith('/cursor-team-kit/LICENSE')) {
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
    assert.ok(fetchMock.mock.calls.every((call) => !String(call.arguments[0]).includes('/pstack/')))
    assert.equal(source.skillFiles, 'referenced')
    assert.equal(source.commit, BUNDLED_CURSOR_PLUGINS_COMMIT)

    const skillBody = await readFile(
      join(cacheDir, 'plugins', 'cursor-team-kit', 'skills', 'demo-skill', 'SKILL.md'),
      'utf8',
    )
    assert.match(skillBody, /# Demo/)
    assert.match(
      await readFile(join(cacheDir, 'plugins', 'cursor-team-kit', 'LICENSE'), 'utf8'),
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
    const skillDir = join(cacheDir, 'plugins', 'cursor-team-kit', 'skills', 'demo-skill')
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
      'cursor-team-kit/demo-skill': ['playbooks/absent.md', 'scripts/cli.ts'],
    })
  })

  it('rejects a snapshot whose missing references drift from SOURCE.json', async () => {
    await syncBundledCursorSkills(cacheDir)
    const sourcePath = join(cacheDir, 'SOURCE.json')
    const manifest = expectRecord(parseJsonUnknown(await readFile(sourcePath, 'utf8')))
    await writeFile(sourcePath, JSON.stringify({ ...manifest, danglingReferences: {} }), 'utf8')
    await assert.rejects(assertBundledCursorSkillsSnapshot(cacheDir), /missing references changed/)
  })

  it('refreshes generated diagnostics while keeping verified payload bytes immutable', async () => {
    const original = await syncBundledCursorSkills(cacheDir)
    const sourcePath = join(cacheDir, 'SOURCE.json')
    await writeFile(
      sourcePath,
      JSON.stringify({
        ...original,
        danglingReferences: { 'demo-plugin/demo-skill': ['scripts/snapshot.sh'] },
      }),
    )
    const updated = await refreshBundledSkillReferences(cacheDir)
    assert.deepEqual(updated.danglingReferences, original.danglingReferences)
    assert.equal(updated.contentSha256, original.contentSha256)
    await writeFile(
      join(cacheDir, 'plugins/demo-plugin/skills/demo-skill/SKILL.md'),
      'changed payload',
    )
    await assert.rejects(refreshBundledSkillReferences(cacheDir), /content hash mismatch/)
  })

  it('does not classify the shipped illustrative snapshot log as a missing dependency', async () => {
    const missing = await findDanglingSkillReferences('vendor/bundled-cursor-skills')
    assert.equal(Object.hasOwn(missing, 'pstack/show-me-your-work'), false)
    assert.deepEqual(missing['orchestrate/orchestrate'], ['scripts/cli.ts'])
  })

  it('matches literal paths, globs and placeholders, but not unrelated names', () => {
    const candidates = ['references/a.md', 'references/sources/x.md', 'playbooks/b.md']
    assert.deepEqual(mentionedSkillFiles('see references/a.md', candidates), ['references/a.md'])
    assert.deepEqual(mentionedSkillFiles('any references/sources/*.md', candidates), [
      'references/sources/x.md',
    ])
    assert.deepEqual(mentionedSkillFiles('references/<name>.md', candidates), ['references/a.md'])
    assert.deepEqual(mentionedSkillFiles('playbooks/c.md and a.md', candidates), [])
    const log =
      '```tsv\nts\tphase\tevidence\tresult\n2026-05-24\tharness\tscripts/snapshot.sh\tsaved\n```'
    assert.deepEqual(mentionedSkillFiles(log, ['scripts/snapshot.sh']), [])
    assert.deepEqual(
      mentionedSkillFiles(
        '```tsv\nstep\tcommand\tresult\nsetup\tbash scripts/required.sh\tready\n```',
        ['scripts/required.sh'],
      ),
      ['scripts/required.sh'],
    )
    assert.deepEqual(
      mentionedSkillFiles(`${log}\nRun scripts/snapshot.sh`, ['scripts/snapshot.sh']),
      ['scripts/snapshot.sh'],
    )
  })

  it('rejects an optional plugin reintroduced into the release snapshot', async () => {
    await syncBundledCursorSkills(cacheDir)
    await mkdir(join(cacheDir, 'plugins', 'pstack'))
    await assert.rejects(
      assertBundledCursorSkillsSnapshot(cacheDir),
      /not selected for bundling: pstack/,
    )
  })

  it('rejects a modified vendored skill', async () => {
    await syncBundledCursorSkills(cacheDir)
    await writeFile(
      join(cacheDir, 'plugins', 'cursor-team-kit', 'skills', 'demo-skill', 'SKILL.md'),
      '# modified after sync',
      'utf8',
    )
    await assert.rejects(assertBundledCursorSkillsSnapshot(cacheDir), /content hash mismatch/)
  })
})
