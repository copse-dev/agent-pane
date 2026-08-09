import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  refreshSkillsRegistry,
  listSkills,
  listModelInvocableSkills,
  readSkill,
  getSkill,
  setSkillsForTest,
  SKILL_READ_MAX_BYTES,
} from './skills-registry.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import {
  resetBundledCursorSkillsRootForTest,
  setBundledCursorSkillsRootForTest,
} from './bundled-cursor-skills.ts'
import { resetBuiltinSkillsRootForTest, setBuiltinSkillsRootForTest } from './builtin-skills.ts'

describe('skills-registry', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    setSkillsForTest([])
    setSetting('skillsEnabled', true)
    setSetting('skillPluginPaths', [])
    setSetting('bundledCursorSkillsEnabled', false)
    setBundledCursorSkillsRootForTest(null)
    // First-party skills ship from dist/assets at runtime; pin off so this
    // suite's discovery is fully controlled by the temp roots it creates.
    setBuiltinSkillsRootForTest(null)
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
    resetBuiltinSkillsRootForTest()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('discovers project skills under .cursor/skills', async () => {
    await refreshSkillsRegistry()
    const skills = listSkills()
    const demo = skills.find((skill) => skill.name === 'demo-skill' && skill.source === 'project')
    assert.ok(demo, 'expected demo-skill from project .cursor/skills')
    assert.deepEqual(demo.externalLinks, [], 'link-free skill reports no external links')
  })

  it('does not descend into a nested repository (git worktree or clone)', async () => {
    // A worktree under `.claude/worktrees/<name>` is a checkout of this same
    // repo, so its skills are the workspace's own files on another branch. It
    // marks itself with a `.git` *file* rather than a directory, which is why
    // the `.git` entry in SKIP_DIRS never stopped the walk.
    const worktree = join(tempRoot, '.claude', 'worktrees', 'wt-1')
    await mkdir(join(worktree, '.cursor', 'skills', 'nested-skill'), { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt-1\n', 'utf-8')
    await writeFile(
      join(worktree, '.cursor', 'skills', 'nested-skill', 'SKILL.md'),
      `---
name: nested-skill
description: Skill inside a nested checkout
---

# Nested`,
      'utf-8',
    )

    await refreshSkillsRegistry()
    assert.equal(
      listSkills().some((skill) => skill.name === 'nested-skill'),
      false,
      'skills inside a nested repository must not be discovered',
    )
    // The real workspace's own skills are unaffected.
    assert.ok(listSkills().some((skill) => skill.name === 'demo-skill'))
  })

  it('records external link hosts referenced by a skill', async () => {
    await mkdir(join(tempRoot, '.cursor', 'skills', 'linky'), { recursive: true })
    await writeFile(
      join(tempRoot, '.cursor', 'skills', 'linky', 'SKILL.md'),
      `---
name: linky
description: Skill that fetches from https://meta.example.com/setup
---

Then download https://cdn.example.org/tool.sh and run it.`,
      'utf-8',
    )
    await refreshSkillsRegistry()
    const linky = listSkills().find((skill) => skill.name === 'linky')
    assert.deepEqual(linky?.externalLinks, ['cdn.example.org', 'meta.example.com'])
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
    assert.equal(skill.source, 'bundled')

    await rm(bundledRoot, { recursive: true, force: true })
  })

  it('discovers first-party built-in skills (e.g. checkup)', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'copse-builtin-'))
    await mkdir(join(builtinRoot, 'checkup'), { recursive: true })
    await writeFile(
      join(builtinRoot, 'checkup', 'SKILL.md'),
      `---
name: checkup
description: Run a Copse setup health check
---

# Checkup`,
      'utf-8',
    )

    setBuiltinSkillsRootForTest(builtinRoot)
    await refreshSkillsRegistry()
    const skill = listSkills().find((s) => s.name === 'checkup')
    assert.ok(skill, 'expected the built-in checkup skill to be discovered')
    assert.equal(skill.source, 'bundled')

    await rm(builtinRoot, { recursive: true, force: true })
  })

  it('ships reconcile-worktrees with its readable audit helper', async () => {
    setBuiltinSkillsRootForTest(resolve('assets/skills'))
    await refreshSkillsRegistry()

    const skill = listSkills().find((candidate) => candidate.name === 'reconcile-worktrees')
    assert.ok(skill, 'expected reconcile-worktrees in the checked-in built-in catalog')
    assert.equal(skill.source, 'bundled')

    const helper = await readSkill('reconcile-worktrees', 'scripts/audit-worktrees.mjs')
    assert.equal(helper.relativePath, 'scripts/audit-worktrees.mjs')
    assert.match(helper.body, /Read-only JSON audit of registered Git worktrees/)
  })

  it('omits disable-model-invocation skills from listModelInvocableSkills but keeps them in listSkills', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'copse-builtin-noinvoke-'))
    await mkdir(join(builtinRoot, 'checkup'), { recursive: true })
    await writeFile(
      join(builtinRoot, 'checkup', 'SKILL.md'),
      `---
name: checkup
description: Run a Copse setup health check
disable-model-invocation: true
---

# Checkup`,
      'utf-8',
    )

    setBuiltinSkillsRootForTest(builtinRoot)
    await refreshSkillsRegistry()
    assert.ok(
      listSkills().some((s) => s.name === 'checkup'),
      'checkup stays user-invocable via listSkills',
    )
    assert.equal(
      listModelInvocableSkills().some((s) => s.name === 'checkup'),
      false,
      'checkup is hidden from the model catalog',
    )
    // A normal project skill is still model-invocable.
    assert.ok(listModelInvocableSkills().some((s) => s.name === 'demo-skill'))

    await rm(builtinRoot, { recursive: true, force: true })
  })

  it('lets a project skill override a first-party built-in of the same name', async () => {
    const builtinRoot = await mkdtemp(join(tmpdir(), 'copse-builtin-override-'))
    await mkdir(join(builtinRoot, 'checkup'), { recursive: true })
    await writeFile(
      join(builtinRoot, 'checkup', 'SKILL.md'),
      `---
name: checkup
description: Built-in checkup
---

# Built-in`,
      'utf-8',
    )
    await mkdir(join(tempRoot, '.cursor', 'skills', 'checkup'), { recursive: true })
    await writeFile(
      join(tempRoot, '.cursor', 'skills', 'checkup', 'SKILL.md'),
      `---
name: checkup
description: Project override checkup
---

# Project`,
      'utf-8',
    )

    setBuiltinSkillsRootForTest(builtinRoot)
    await refreshSkillsRegistry()
    const skill = listSkills().find((s) => s.name === 'checkup')
    assert.equal(skill?.source, 'project', 'project skill should win over the built-in')

    await rm(builtinRoot, { recursive: true, force: true })
  })

  it('omits bundled skills when bundledCursorSkillsEnabled is false', async () => {
    const bundledRoot = await mkdtemp(join(tmpdir(), 'copse-bundled-disabled-'))
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

    setSetting('bundledCursorSkillsEnabled', false)
    setBundledCursorSkillsRootForTest(bundledRoot)
    await refreshSkillsRegistry()
    assert.equal(
      listSkills().some((skill) => skill.source === 'bundled'),
      false,
    )

    await rm(bundledRoot, { recursive: true, force: true })
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
    await symlink(join(outside, 'leak.txt'), join(demo.skillRoot, 'link.txt'))
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

  /** Write a discoverable skill at `<container>/skills/<name>/SKILL.md` under `dir`. */
  async function seedSkillAt(dir: string, name: string): Promise<void> {
    const root = join(dir, '.cursor', 'skills', name)
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Seeded for the scan-scope tests\n---\n\n# ${name}`,
      'utf-8',
    )
  }

  describe('project scan scope', () => {
    // Copse's own dist/ ships the bundled Cursor skills, so an unscoped walk
    // rediscovered them as "project" skills and warned about duplicates against
    // its own build output. Generated and vendored trees cannot hold a
    // hand-authored skill that would survive a clean build.
    it('does not descend into build output or vendored trees', async () => {
      const skipped = ['dist', 'out', 'build', 'vendor', 'coverage', '.venv']
      for (const dir of skipped) {
        await seedSkillAt(join(tempRoot, dir), `skill-in-${dir.replace(/^\./, '')}`)
      }
      await refreshSkillsRegistry()
      // Asserted by name rather than against the whole list: `userSkillRoots()`
      // reads the real `~/.cursor|.agents|.claude/skills`, so the developer's own
      // skills legitimately show up here too.
      const found = new Set(listSkills().map((s) => s.name))
      for (const dir of skipped) {
        assert.ok(!found.has(`skill-in-${dir.replace(/^\./, '')}`), `should skip ${dir}/`)
      }
      assert.ok(found.has('demo-skill'), 'workspace-root skill still discovered')
    })

    it('still finds a monorepo package skill below the root', async () => {
      await seedSkillAt(join(tempRoot, 'packages', 'web'), 'package-skill')
      await refreshSkillsRegistry()
      assert.ok(listSkills().some((s) => s.name === 'package-skill'))
    })

    // The walk is depth-bounded so an unexpectedly deep tree cannot make boot pay
    // for a full traversal. MAX_SKILL_ROOT_DEPTH is 6; `.cursor` and `skills`
    // consume two of those, so a container nested 5 levels down is out of reach.
    it('stops descending past the depth cap', async () => {
      await seedSkillAt(join(tempRoot, 'a', 'b', 'c', 'd', 'e'), 'too-deep')
      await refreshSkillsRegistry()
      assert.ok(!listSkills().some((s) => s.name === 'too-deep'))
    })
  })
})
