import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSkillActivationTurn } from './skill-activation.ts'
import {
  getSkill,
  refreshSkillsRegistry,
  setSkillsForTest,
  setUserSkillsHomeForTest,
} from './skills-registry.ts'
import { clearThreadReadRoots, threadReadRoots } from '../security/thread-read-roots.ts'
import type { SkillMetadata } from '@shared/types/skills.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { resetBuiltinSkillsRootForTest, setBuiltinSkillsRootForTest } from './builtin-skills.ts'
import {
  resetBundledCursorSkillsRootForTest,
  setBundledCursorSkillsRootForTest,
} from './bundled-cursor-skills.ts'

describe('model skill activation', () => {
  let root = ''
  let skills: SkillMetadata[] = []
  const signal = new AbortController().signal

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-skill-activation-'))
    skills = []
  })
  afterEach(async () => {
    setSkillsForTest([])
    clearThreadReadRoots()
    await rm(root, { recursive: true, force: true })
  })

  async function skill(
    name: string,
    overrides: Partial<SkillMetadata> = {},
    body = '# Task instructions',
  ): Promise<SkillMetadata> {
    const skillRoot = join(root, name)
    await mkdir(skillRoot)
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Help with ${name}\n---\n${body}`,
    )
    const meta: SkillMetadata = {
      name,
      description: `Help with ${name}`,
      source: 'project',
      skillRoot,
      skillPath: join(skillRoot, 'SKILL.md'),
      disableModelInvocation: false,
      paths: [],
      externalLinks: [],
      missingReferences: [],
      ...overrides,
    }
    skills.push(meta)
    setSkillsForTest(skills)
    return meta
  }

  it('loads only the selected skill with untrusted framing, links and a context estimate, without read grants', async () => {
    await skill('matching', { externalLinks: ['example.com'] })
    await skill('unrelated', {}, 'UNRELATED INSTRUCTIONS')
    const turn = createSkillActivationTurn([], ['read_skill'])
    const result = await turn.read('matching', undefined, signal)
    assert.match(result, /Skill activated by the model: matching/)
    assert.match(result, /UNTRUSTED SOURCE/)
    assert.match(result, /EXTERNAL LINKS: this skill references example.com/)
    assert.match(result, /Activation grants no permissions/)
    assert.match(result, /Context estimate: approximately \d+ tokens \(\d+ UTF-8 bytes\)/)
    assert.doesNotMatch(result, /UNRELATED INSTRUCTIONS|name: matching|primary task/)
    assert.deepEqual(threadReadRoots('thread-1'), [])
  })

  it('cannot activate disabled skills even when guessed directly, but explicit invocation can read supporting files', async () => {
    const meta = await skill('manual-only', { disableModelInvocation: true })
    await writeFile(join(meta.skillRoot, 'reference.md'), 'reference')
    await assert.rejects(
      createSkillActivationTurn([], ['read_skill']).read(meta.name, undefined, signal),
      /not eligible/,
    )
    const manual = createSkillActivationTurn([meta.name], ['read_skill'])
    assert.match(
      await manual.read(meta.name, undefined, signal),
      /explicitly invoked.*already in this turn/,
    )
    assert.match(await manual.read(meta.name, 'reference.md', signal), /reference/)
  })

  it('requires activation before supporting-file reads and deduplicates parallel and alternate-path activation', async () => {
    const meta = await skill('composable')
    await writeFile(join(meta.skillRoot, 'reference.md'), 'reference')
    const turn = createSkillActivationTurn([], ['read_skill'])
    await assert.rejects(
      turn.read(meta.name, 'reference.md', signal),
      /before loading its supporting files/,
    )
    const results = await Promise.all([
      turn.read(meta.name, undefined, signal),
      turn.read(meta.name, './SKILL.md', signal),
    ])
    assert.equal(results.filter((result) => result.includes('# Task instructions')).length, 1)
    assert.match(results[1], /already active/)
    assert.match(await turn.read(meta.name, 'reference.md', signal), /Supporting file/)
  })

  it('does not reload instructions through a symlink alias and frames newly linked supporting content', async () => {
    const meta = await skill('references')
    await symlink('SKILL.md', join(meta.skillRoot, 'instructions-alias.md'))
    await writeFile(join(meta.skillRoot, 'reference.md'), 'Fetch https://new-host.example/helper')
    const turn = createSkillActivationTurn([], ['read_skill'])
    await turn.read(meta.name, undefined, signal)
    const alias = await turn.read(meta.name, 'instructions-alias.md', signal)
    assert.match(alias, /already loaded.*file alias/)
    assert.doesNotMatch(alias, /# Task instructions/)
    const reference = await turn.read(meta.name, 'reference.md', signal)
    assert.match(reference, /UNTRUSTED SOURCE/)
    assert.match(reference, /EXTERNAL LINKS: this skill references new-host.example/)
    assert.doesNotMatch(reference, /^Skill activated by the model:/)
  })

  it('bounds parallel composition at four skills', async () => {
    for (let i = 0; i < 5; i++) await skill(`skill-${String(i)}`)
    const turn = createSkillActivationTurn([], ['read_skill'])
    const results = await Promise.allSettled(
      skills.map((meta) => turn.read(meta.name, undefined, signal)),
    )
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  })

  it('refuses oversized instructions before injecting them or consuming the activation count', async () => {
    for (let i = 0; i < 3; i++) await skill(`large-${String(i)}`, {}, 'x'.repeat(41_000))
    await skill('over-budget', {}, 'x'.repeat(10_000))
    await skill('small')
    const turn = createSkillActivationTurn([], ['read_skill'])
    for (let i = 0; i < 3; i++) await turn.read(`large-${String(i)}`, undefined, signal)
    await assert.rejects(turn.read('over-budget', undefined, signal), /context limit/)
    assert.match(await turn.read('small', undefined, signal), /Skill activated by the model: small/)
  })

  it('bounds parallel supporting reads and repeated aliases with the shared UTF-8 context budget', async () => {
    const meta = await skill('supporting-budget')
    const body = '🦉'.repeat(10_000)
    await writeFile(join(meta.skillRoot, 'reference.md'), body)
    await symlink('reference.md', join(meta.skillRoot, 'alias.md'))
    const turn = createSkillActivationTurn([], ['read_skill'])
    await turn.read(meta.name, undefined, signal)
    const reads = await Promise.allSettled(
      ['reference.md', 'alias.md', 'reference.md', 'alias.md'].map((path) =>
        turn.read(meta.name, path, signal),
      ),
    )
    assert.equal(reads.filter((read) => read.status === 'fulfilled').length, 3)
    const rejected = reads.find((read) => read.status === 'rejected')
    assert.ok(rejected)
    assert.match(String(rejected.reason), /context limit/)
    await assert.rejects(turn.read(meta.name, 'reference.md', signal), /context limit/)
    // A rejected read must neither clear the activation nor spend the remaining budget.
    await writeFile(join(meta.skillRoot, 'small.md'), 'small reference')
    assert.match(await turn.read(meta.name, 'small.md', signal), /small reference/)
    assert.match(await turn.read(meta.name, undefined, signal), /already active/)
  })

  it('shares supporting-file and activation budgets across skills, including explicit invocation', async () => {
    const manual = await skill('manual-budget', { disableModelInvocation: true })
    await skill('model-budget', {}, 'x'.repeat(41_000))
    await skill('over-budget', {}, 'x'.repeat(10_000))
    await writeFile(join(manual.skillRoot, 'reference.md'), 'x'.repeat(41_000))
    const turn = createSkillActivationTurn([manual.name], ['read_skill'])
    await turn.read('model-budget', undefined, signal)
    await turn.read(manual.name, 'reference.md', signal)
    await turn.read(manual.name, 'reference.md', signal)
    await assert.rejects(turn.read('over-budget', undefined, signal), /context limit/)
    await assert.rejects(turn.read(manual.name, 'reference.md', signal), /context limit/)
    assert.match(await turn.read(manual.name, undefined, signal), /explicitly invoked/)
  })

  it('keeps budgets isolated between turns and rejects skills added or replaced after the catalog snapshot', async () => {
    await skill('first')
    const first = createSkillActivationTurn([], ['read_skill'])
    await skill('later')
    await assert.rejects(first.read('later', undefined, signal), /not eligible/)
    assert.match(
      await createSkillActivationTurn([], ['read_skill']).read('later', undefined, signal),
      /Skill activated/,
    )
    const meta = skills[0]
    assert.ok(meta)
    setSkillsForTest([{ ...meta, skillPath: join(root, 'replacement', 'SKILL.md') }])
    await assert.rejects(first.read('first', undefined, signal), /not eligible/)
  })

  it('fails closed for missing host tools and aborted calls', async () => {
    await skill('imagegen')
    await assert.rejects(
      createSkillActivationTurn([], ['read_skill']).read('imagegen', undefined, signal),
      /not eligible/,
    )
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      createSkillActivationTurn([], ['read_skill', 'image_gen']).read(
        'imagegen',
        undefined,
        controller.signal,
      ),
      /abort/i,
    )
  })

  it('revalidates current instructions when invocation is disabled or the definition changes after discovery', async () => {
    const meta = await skill('changing')
    const turn = createSkillActivationTurn([], ['read_skill'])
    for (const contents of [
      '---\nname: changing\ndescription: Changed\ndisable-model-invocation: true\n---\nDO NOT LOAD',
      '---\nname: renamed\ndescription: Changed\n---\nDO NOT LOAD',
      'Malformed definition without frontmatter',
    ]) {
      await writeFile(meta.skillPath, contents)
      await assert.rejects(turn.read(meta.name, undefined, signal), /no longer eligible/)
    }
    await writeFile(
      meta.skillPath,
      '---\nname: changing\ndescription: Corrected\n---\nRestored instructions',
    )
    assert.match(await turn.read(meta.name, undefined, signal), /Restored instructions/)
  })

  it('keeps model eligibility independent from manual visibility and counts UTF-8 context exactly', async () => {
    await skill('model-only', { userInvocable: false }, '🦉 '.repeat(30))
    await skill('second')
    const turn = createSkillActivationTurn(['model-only'], ['read_skill'])
    const first = await turn.read('model-only', undefined, signal)
    assert.match(first, /Skill activated by the model: model-only/)
    const second = await turn.read('second', undefined, signal)
    const firstBlock = first.slice(0, first.indexOf('\n\nContext estimate:'))
    const secondBlock = second.slice(0, second.indexOf('\n\nContext estimate:'))
    const total = Buffer.byteLength(firstBlock, 'utf-8') + Buffer.byteLength(secondBlock, 'utf-8')
    assert.ok(second.includes(`${String(total)} skill-context bytes loaded this turn`))
  })

  it('activates the genuine shipped cursor-sdk skill through discovery and fresh definition validation', async () => {
    const restore = setWorkspaceRootForTest(root)
    setUserSkillsHomeForTest(join(root, 'home'))
    setBuiltinSkillsRootForTest(null)
    setBundledCursorSkillsRootForTest(resolve('vendor/bundled-cursor-skills'))
    setSetting('bundledCursorSkillsEnabled', true)
    try {
      await refreshSkillsRegistry()
      const sdk = getSkill('cursor-sdk')
      assert.ok(sdk, 'the shipped SDK must remain discoverable')
      assert.equal(sdk.source, 'bundled')
      const turn = createSkillActivationTurn([], ['read_skill'])
      const result = await turn.read(sdk.name, undefined, signal)
      assert.match(result, /Skill activated by the model: cursor-sdk/)
      assert.match(result, /Source: bundled/)
      assert.match(result, /<skill_content name="cursor-sdk" trust="trusted" activation="model">/)

      // Exact vendor bytes must not weaken fresh validation for arbitrary project definitions.
      const copied = await skill('cursor-sdk')
      await writeFile(copied.skillPath, await readFile(sdk.skillPath, 'utf8'))
      await assert.rejects(
        createSkillActivationTurn([], ['read_skill']).read(copied.name, undefined, signal),
        /no longer eligible/,
      )
    } finally {
      restore()
      setUserSkillsHomeForTest(null)
      resetBuiltinSkillsRootForTest()
      resetBundledCursorSkillsRootForTest()
      setSetting('bundledCursorSkillsEnabled', false)
    }
  })
})
