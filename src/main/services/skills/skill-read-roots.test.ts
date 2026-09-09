import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  declaredSkillPathProblem,
  grantInvokedSkillReadRoots,
  resolveSkillReadRoots,
} from './skill-read-roots.ts'
import { clearThreadReadRoots, threadReadRoots } from '../security/thread-read-roots.ts'
import type { SkillSource } from '@shared/types/skills.ts'

describe('declaredSkillPathProblem', () => {
  it('accepts plain relative entries', () => {
    assert.equal(declaredSkillPathProblem('scripts'), null)
    assert.equal(declaredSkillPathProblem('references/schema.json'), null)
    assert.equal(declaredSkillPathProblem('./assets'), null)
  })

  it('rejects absolute, home-relative and variable entries', () => {
    assert.match(declaredSkillPathProblem('/etc') ?? '', /relative/)
    assert.match(declaredSkillPathProblem('~/.aws') ?? '', /relative/)
    assert.match(declaredSkillPathProblem('$HOME/x') ?? '', /relative/)
  })

  it('rejects parent traversal and empty entries', () => {
    assert.match(declaredSkillPathProblem('../sibling') ?? '', /\.\./)
    assert.match(declaredSkillPathProblem('scripts/../../x') ?? '', /\.\./)
    assert.match(declaredSkillPathProblem('   ') ?? '', /empty/)
  })
})

describe('resolveSkillReadRoots', () => {
  let home = ''
  let skillRoot = ''

  const skill = (
    paths: string[],
    source: SkillSource = 'user',
  ): { name: string; skillRoot: string; source: SkillSource; paths: string[] } => ({
    name: 'demo',
    skillRoot,
    source,
    paths,
  })

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'copse-skill-home-')))
    skillRoot = join(home, '.codex', 'skills', 'demo')
    await mkdir(join(skillRoot, 'scripts'), { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n')
    await writeFile(join(skillRoot, 'scripts', 'audit.mjs'), 'export {}\n')
  })

  afterEach(async () => {
    clearThreadReadRoots()
    await rm(home, { recursive: true, force: true })
  })

  it('always grants the skill directory itself', async () => {
    const result = await resolveSkillReadRoots(skill([]), { homeDir: home })
    assert.deepEqual(result.rejected, [])
    assert.deepEqual(
      result.granted.map((root) => [root.path, root.canonical, root.isDirectory]),
      [[skillRoot, skillRoot, true]],
    )
  })

  it('records the discovered spelling and the realpath of a symlinked skill', async () => {
    const real = join(home, 'dotfiles', 'skills', 'demo')
    await mkdir(join(home, 'dotfiles', 'skills'), { recursive: true })
    await rm(skillRoot, { recursive: true, force: true })
    await mkdir(real, { recursive: true })
    await symlink(real, skillRoot)
    const result = await resolveSkillReadRoots(skill([]), { homeDir: home })
    assert.deepEqual(
      result.granted.map((root) => [root.path, root.canonical]),
      [[skillRoot, real]],
    )
  })

  it('folds a declared path inside the skill directory into that grant', async () => {
    const result = await resolveSkillReadRoots(skill(['scripts', 'scripts/audit.mjs']), {
      homeDir: home,
    })
    assert.deepEqual(result.rejected, [])
    assert.equal(result.granted.length, 1, 'already covered by the directory grant')
  })

  it('rejects absolute, traversing, missing and credential entries by name', async () => {
    const result = await resolveSkillReadRoots(
      skill(['/etc/passwd', '../other-skill', 'missing.txt', 'scripts/.env']),
      { homeDir: home },
    )
    assert.deepEqual(result.granted.length, 1)
    assert.deepEqual(
      result.rejected.map((line) => line.split(':')[0]),
      ['/etc/passwd', '../other-skill', 'missing.txt', 'scripts/.env'],
    )
    assert.match(result.rejected[3] ?? '', /credential/)
  })

  it('lets a trusted skill follow a symlink out of its directory, within limits', async () => {
    const data = join(home, 'datasets')
    await mkdir(data, { recursive: true })
    await symlink(data, join(skillRoot, 'data'))
    await symlink(join(home, '.ssh'), join(skillRoot, 'keys'))
    await mkdir(join(home, '.ssh'), { recursive: true })
    await symlink(home, join(skillRoot, 'everything'))

    const result = await resolveSkillReadRoots(skill(['data', 'keys', 'everything'], 'user'), {
      homeDir: home,
    })
    assert.deepEqual(
      result.granted.map((root) => [root.path, root.canonical, root.isDirectory]),
      [
        [skillRoot, skillRoot, true],
        [join(skillRoot, 'data'), data, true],
      ],
    )
    assert.match(result.rejected[0] ?? '', /^keys: credential directory/)
    assert.match(result.rejected[1] ?? '', /^everything: is the whole home directory/)
  })

  it('refuses a symlink escape from an untrusted (workspace or plugin) skill', async () => {
    const data = join(home, 'datasets')
    await mkdir(data, { recursive: true })
    await symlink(data, join(skillRoot, 'data'))
    for (const source of ['project', 'plugin', 'plugin-path'] as const) {
      const result = await resolveSkillReadRoots(skill(['data'], source), { homeDir: home })
      assert.equal(result.granted.length, 1, source)
      assert.match(result.rejected[0] ?? '', /symlink leaves the skill directory/)
    }
  })

  it('grants nothing when the skill directory is itself a credential store', async () => {
    const inSsh = join(home, '.ssh', 'skills', 'demo')
    await mkdir(inSsh, { recursive: true })
    const result = await resolveSkillReadRoots(
      { ...skill([]), skillRoot: inSsh },
      { homeDir: home },
    )
    assert.deepEqual(result.granted, [])
    assert.match(result.rejected[0] ?? '', /credential directory/)
  })

  it('grants nothing when the skill directory is missing', async () => {
    const result = await resolveSkillReadRoots(
      { ...skill([]), skillRoot: join(home, 'nope') },
      { homeDir: home },
    )
    assert.deepEqual(result.granted, [])
    assert.match(result.rejected[0] ?? '', /missing/)
  })

  it('grantInvokedSkillReadRoots records the granted roots on the thread', async () => {
    const result = await grantInvokedSkillReadRoots('thread-1', skill([]))
    assert.equal(result.granted.length, 1)
    assert.deepEqual(
      threadReadRoots('thread-1').map((root) => root.canonical),
      [skillRoot],
    )
    assert.deepEqual(threadReadRoots('thread-2'), [])
  })
})
