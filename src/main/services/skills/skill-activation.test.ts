import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MAX_WORKFLOW_DEPENDENCY_SKILLS, createSkillActivationTurn } from './skill-activation.ts'
import { isSkillDependencyInScope } from './skill-dependencies.ts'
import { buildInvokedSkillsBlock } from './skill-prompt.ts'
import { buildSystemPromptWithMetadata } from '../agent-system-prompt.ts'
import {
  getSkill,
  getSkillAvailability,
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
      `---\nname: ${name}\ndescription: Help with ${name}\n${overrides.disableModelInvocation ? 'disable-model-invocation: true\n' : ''}${overrides.dependencies ? `copse-dependencies: ${JSON.stringify(overrides.dependencies)}\n` : ''}---\n${body}`,
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

  it('charges the actual deduplicated UTF-8 manual prompt before automatic and supporting reads', async () => {
    const body = '🌲'.repeat(10_000)
    const manual = await skill('manual-prompt-budget', {}, body)
    const second = await skill('second-manual-budget', {}, 'x'.repeat(45_000))
    await skill('automatic-prompt-budget', {}, 'x'.repeat(45_000))
    await writeFile(join(manual.skillRoot, 'large.md'), 'x'.repeat(45_000))
    await writeFile(join(manual.skillRoot, 'small.md'), 'small reference')
    const restore = setWorkspaceRootForTest(root)
    try {
      const empty = await buildSystemPromptWithMetadata({
        subagentsEnabled: false,
        invokedSkills: [],
      })
      const built = await buildSystemPromptWithMetadata({
        subagentsEnabled: false,
        invokedSkills: [manual.name, second.name, manual.name],
      })
      assert.equal(empty.invokedSkillContextBytes, 0)
      assert.equal(built.prompt.split(body).length, 2)
      assert.equal(
        built.invokedSkillContextBytes,
        Buffer.byteLength(built.prompt, 'utf8') - Buffer.byteLength(empty.prompt, 'utf8'),
      )
      assert.ok(built.invokedSkillContextBytes > 80_000)
      const turn = createSkillActivationTurn(
        [manual.name],
        ['read_skill'],
        built.invokedSkillContextBytes,
      )
      assert.match(await turn.read(manual.name, undefined, signal), /explicitly invoked/)
      await assert.rejects(turn.read('automatic-prompt-budget', undefined, signal), /context limit/)
      await assert.rejects(turn.read(manual.name, 'large.md', signal), /context limit/)
      assert.match(await turn.read(manual.name, 'small.md', signal), /small reference/)
    } finally {
      restore()
    }
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

  it('loads declared manual-only leaves and supporting files, with source trust and root precedence', async () => {
    await skill('workflow', { dependencies: ['leaf'], disableModelInvocation: true })
    const leaf = await skill('leaf', { disableModelInvocation: true }, 'LEAF INSTRUCTIONS')
    await skill('undeclared', { disableModelInvocation: true })
    await writeFile(join(leaf.skillRoot, 'support.md'), 'LEAF SUPPORT')
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'])
    await assert.rejects(turn.read('leaf', 'support.md', signal), /before loading/)
    const block = await turn.read('leaf', undefined, signal)
    assert.match(block, /Workflow dependency activated: leaf \(declared by workflow\)/)
    assert.match(block, /activation="dependency"/)
    assert.match(block, /UNTRUSTED SOURCE/)
    assert.match(block, /manually invoked skills take priority/)
    assert.match(await turn.read('leaf', 'support.md', signal), /LEAF SUPPORT/)
    assert.match(await turn.read('leaf', undefined, signal), /already active/)
    await assert.rejects(turn.read('undeclared', undefined, signal), /not eligible/)
    assert.deepEqual(threadReadRoots('workflow-thread'), [])
    const prompt = await buildInvokedSkillsBlock(['workflow'])
    assert.match(prompt, /Declared workflow dependencies: leaf/)
    assert.doesNotMatch(prompt, /LEAF INSTRUCTIONS/)
  })

  it('does not grant dependency authority to model selection, textual mention or non-invocable roots', async () => {
    await skill('workflow', { dependencies: ['leaf'] }, 'Mention undeclared-helper')
    await skill('leaf', { disableModelInvocation: true })
    await skill('hidden-root', { dependencies: ['leaf'], userInvocable: false })
    const selected = createSkillActivationTurn([], ['read_skill'])
    await selected.read('workflow', undefined, signal)
    await assert.rejects(selected.read('leaf', undefined, signal), /not eligible/)
    await assert.rejects(
      createSkillActivationTurn(['hidden-root'], ['read_skill']).read('leaf', undefined, signal),
      /not eligible/,
    )
  })

  it('rejects cross-source, plugin and container winners without substituting shadowed skills', async () => {
    const parent = await skill('workflow', { dependencies: ['leaf'] })
    const leaf = await skill('leaf', { disableModelInvocation: true })
    assert.equal(isSkillDependencyInScope(parent, leaf), true)
    for (const replacement of [
      { ...leaf, source: 'user' as const },
      { ...leaf, plugin: 'other-plugin' },
      { ...leaf, skillRoot: join(root, 'different-container', 'leaf') },
    ]) {
      assert.equal(isSkillDependencyInScope(parent, replacement), false)
      setSkillsForTest([parent, replacement])
      await assert.rejects(
        createSkillActivationTurn(['workflow'], ['read_skill']).read('leaf', undefined, signal),
        /same skill container, source and plugin/,
      )
    }
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'])
    setSkillsForTest([parent, leaf])
    await assert.rejects(
      turn.read('leaf', undefined, signal),
      /same skill container, source and plugin/,
    )
  })

  it('keeps disabled or removed dependencies inaccessible, including after activation', async () => {
    const parent = await skill('workflow', { dependencies: ['leaf'] })
    const leaf = await skill('leaf', { disableModelInvocation: true })
    await writeFile(join(leaf.skillRoot, 'support.md'), 'SUPPORT')
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'])
    await turn.read('leaf', undefined, signal)
    setSkillsForTest([parent])
    await assert.rejects(turn.read('leaf', 'support.md', signal), /Unknown skill/)
    await assert.rejects(
      createSkillActivationTurn(['workflow'], ['read_skill']).read('leaf', undefined, signal),
      /Unknown skill/,
    )
    // An already-authorized descendant cannot outlive its root's availability.
    setSkillsForTest([leaf])
    await assert.rejects(turn.read('leaf', 'support.md', signal), /no longer available/)
  })

  it('honors live bundled-plugin and global off-switches without a registry reload', async () => {
    const parent = await skill('workflow', {
      source: 'bundled',
      plugin: 'workflow-plugin',
      dependencies: ['leaf'],
    })
    const leaf = await skill('leaf', {
      source: 'bundled',
      plugin: 'workflow-plugin',
      disableModelInvocation: true,
    })
    await writeFile(join(leaf.skillRoot, 'support.md'), 'SUPPORT')
    setSetting('bundledCursorSkillsEnabled', true)
    setSetting('bundledSkillPluginOverrides', { 'workflow-plugin': true })
    try {
      const turn = createSkillActivationTurn([parent.name], ['read_skill'])
      await turn.read('leaf', undefined, signal)
      assert.equal(getSkillAvailability('leaf'), 'supported')
      assert.equal(getSkillAvailability('absent'), 'unavailable')
      setSetting('bundledSkillPluginOverrides', { 'workflow-plugin': false })
      assert.equal(getSkillAvailability('leaf'), 'disabled')
      assert.equal(getSkillAvailability('workflow-plugin/leaf'), 'disabled')
      assert.equal(getSkillAvailability('workflow-plugin'), 'disabled')
      await assert.rejects(turn.read('leaf', 'support.md', signal), /switched off/)
      await assert.rejects(
        createSkillActivationTurn([parent.name], ['read_skill']).read('leaf', undefined, signal),
        /switched off/,
      )
      setSetting('bundledSkillPluginOverrides', { 'workflow-plugin': true })
      setSetting('bundledCursorSkillsEnabled', false)
      await assert.rejects(turn.read('leaf', undefined, signal), /switched off/)
      setSetting('bundledCursorSkillsEnabled', true)
      setSetting('skillsEnabled', false)
      await assert.rejects(turn.read('leaf', undefined, signal), /Skills are switched off/)
    } finally {
      setSetting('skillsEnabled', true)
      setSetting('bundledCursorSkillsEnabled', false)
      setSetting('bundledSkillPluginOverrides', {})
    }
  })

  it('can authorize descendants of a previously model-activated dependency without reloading its body', async () => {
    await skill('workflow', { dependencies: ['parent-leaf'] })
    await skill('parent-leaf', { dependencies: ['leaf'] })
    await skill('leaf', { dependencies: ['grandchild'] })
    await skill('grandchild', { disableModelInvocation: true })
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'])
    await turn.read('leaf', undefined, signal)
    await assert.rejects(turn.read('grandchild', undefined, signal), /not eligible/)
    await turn.read('parent-leaf', undefined, signal)
    assert.match(await turn.read('leaf', undefined, signal), /already active/)
    assert.match(await turn.read('grandchild', undefined, signal), /Workflow dependency activated/)
  })

  it('bounds cycles and diamonds without recursive loading or duplicate instruction injection', async () => {
    await skill('workflow', { dependencies: ['left', 'right'] })
    await skill('left', { dependencies: ['leaf'], disableModelInvocation: true })
    await skill('right', { dependencies: ['leaf'], disableModelInvocation: true })
    await skill(
      'leaf',
      { dependencies: ['workflow', 'left'], disableModelInvocation: true },
      'UNIQUE LEAF',
    )
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'])
    await assert.rejects(turn.read('leaf', undefined, signal), /not eligible/)
    await Promise.all(['left', 'right'].map((name) => turn.read(name, undefined, signal)))
    const results = await Promise.all([
      turn.read('leaf', undefined, signal),
      turn.read('leaf', './SKILL.md', signal),
    ])
    assert.equal(results.filter((result) => result.includes('UNIQUE LEAF')).length, 1)
    assert.match(await turn.read('workflow', undefined, signal), /explicitly invoked/)
    assert.match(await turn.read('left', undefined, signal), /already active/)
  })

  it('reserves dependency slots atomically across concurrent siblings while retaining four model slots', async () => {
    const names = Array.from(
      { length: MAX_WORKFLOW_DEPENDENCY_SKILLS + 1 },
      (_, i) => `leaf-${String(i)}`,
    )
    await skill('workflow', { dependencies: names.slice(0, 16) })
    await skill('second-workflow', { dependencies: names.slice(16) })
    for (const name of names) await skill(name, { disableModelInvocation: true })
    for (let i = 0; i < 5; i++) await skill(`automatic-${String(i)}`)
    const turn = createSkillActivationTurn(['workflow', 'second-workflow'], ['read_skill'])
    const results = await Promise.allSettled(
      names.map((name) => turn.read(name, undefined, signal)),
    )
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 16)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.ok(rejected)
    assert.match(String(rejected.reason), /dependency activation limit/)
    for (let i = 0; i < 4; i++)
      assert.match(
        await turn.read(`automatic-${String(i)}`, undefined, signal),
        /activated by the model/,
      )
    await assert.rejects(
      turn.read('automatic-4', undefined, signal),
      /Model skill activation limit/,
    )
  })

  it('shares UTF-8 context with concurrent dependencies, repeated supporting reads and explicit prompt bytes', async () => {
    await skill('workflow', { dependencies: ['leaf', 'other'] })
    const leaf = await skill('leaf', { disableModelInvocation: true }, '🦉'.repeat(11_000))
    await skill('other', { disableModelInvocation: true }, '🦉'.repeat(11_000))
    await writeFile(join(leaf.skillRoot, 'support.md'), '🦉'.repeat(11_000))
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'], 50_000)
    const results = await Promise.allSettled(
      ['leaf', 'other'].map((name) => turn.read(name, undefined, signal)),
    )
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.ok(rejected)
    assert.match(String(rejected.reason), /context limit/)
    // Use a fresh turn to make the activated identity deterministic.
    const supportTurn = createSkillActivationTurn(['workflow'], ['read_skill'])
    await supportTurn.read('leaf', undefined, signal)
    await supportTurn.read('leaf', 'support.md', signal)
    await assert.rejects(supportTurn.read('leaf', 'support.md', signal), /context limit/)
    assert.match(await supportTurn.read('leaf', undefined, signal), /already active/)
  })

  it('fails closed on changed declarations, failed loads and aborted activation without granting descendants', async () => {
    const parent = await skill('workflow', { dependencies: ['leaf'] })
    const leaf = await skill('leaf', { dependencies: ['grandchild'], disableModelInvocation: true })
    await skill('grandchild', { disableModelInvocation: true })
    const changed = createSkillActivationTurn(['workflow'], ['read_skill'])
    await writeFile(parent.skillPath, '---\nname: workflow\ndescription: Changed\n---\nChanged')
    await assert.rejects(
      changed.read('leaf', undefined, signal),
      /changed its dependency declaration/,
    )
    await writeFile(
      parent.skillPath,
      '---\nname: workflow\ndescription: Workflow\ncopse-dependencies: [leaf]\n---\nRestored',
    )
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'])
    const controller = new AbortController()
    const pending = turn.read('leaf', undefined, controller.signal)
    controller.abort()
    await assert.rejects(pending, /abort/i)
    await assert.rejects(turn.read('grandchild', undefined, signal), /not eligible/)
    await writeFile(leaf.skillPath, 'Malformed')
    await assert.rejects(turn.read('leaf', undefined, signal), /no longer eligible/)
    await assert.rejects(turn.read('grandchild', undefined, signal), /not eligible/)
    await writeFile(
      leaf.skillPath,
      '---\nname: leaf\ndescription: Leaf\ndisable-model-invocation: true\ncopse-dependencies: [grandchild]\n---\nRestored',
    )
    await turn.read('leaf', undefined, signal)
    assert.match(await turn.read('grandchild', undefined, signal), /Workflow dependency activated/)
  })

  it('rejects concurrent failed activations without authorizing descendants, then permits a corrected retry', async () => {
    await skill('workflow', { dependencies: ['leaf'] })
    const leaf = await skill('leaf', { dependencies: ['grandchild'], disableModelInvocation: true })
    await skill('grandchild', { disableModelInvocation: true })
    await writeFile(leaf.skillPath, 'Malformed')
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'])
    const results = await Promise.allSettled([
      turn.read('leaf', undefined, signal),
      turn.read('leaf', undefined, signal),
    ])
    assert.equal(results.filter((result) => result.status === 'rejected').length, 2)
    await assert.rejects(turn.read('grandchild', undefined, signal), /not eligible/)
    await writeFile(
      leaf.skillPath,
      '---\nname: leaf\ndescription: Leaf\ncopse-dependencies: [grandchild]\n---\nCorrected instructions',
    )
    await turn.read('leaf', undefined, signal)
    assert.match(await turn.read('grandchild', undefined, signal), /Workflow dependency activated/)
  })

  it('rejects canonical container escapes and unavailable dependency tools', async () => {
    await skill('workflow', { dependencies: ['leaf', 'imagegen'] })
    const leaf = await skill('leaf', { disableModelInvocation: true })
    await skill('imagegen', { disableModelInvocation: true })
    const outside = join(root, 'outside')
    await mkdir(outside)
    const escaped = join(outside, 'leaf')
    await mkdir(escaped)
    await writeFile(join(escaped, 'SKILL.md'), await readFile(leaf.skillPath))
    await rm(leaf.skillRoot, { recursive: true })
    await symlink(escaped, leaf.skillRoot)
    const turn = createSkillActivationTurn(['workflow'], ['read_skill'])
    await assert.rejects(turn.read('leaf', undefined, signal), /outside the workflow/)
    await assert.rejects(turn.read('imagegen', undefined, signal), /requires tools unavailable/)
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
