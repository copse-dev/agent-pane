import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  collectDiscoveryRoots,
  discoverAgentsFromRoots,
  type DiscoveryRoot,
} from './agents-registry.ts'
import type { AgentContainer } from '@shared/types/agents.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithWorkspaceTrust } from '../security/workspace-trust.ts'

const DEFINITION = ['---', 'name: reviewer', 'description: from {where}', '---', 'body'].join('\n')

describe('agents-registry', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-agents-'))
  })

  afterEach(async () => {
    restoreWorkspace?.()
    restoreWorkspace = undefined
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = ''
  })

  /** Write `<scope>/<container>/agents/<file>` and return the root it belongs to. */
  async function seed(
    scope: string,
    container: AgentContainer,
    file: string,
    contents: string,
  ): Promise<string> {
    const root = join(tempRoot, scope, container, 'agents')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, file), contents, 'utf-8')
    return root
  }

  function rootsOf(
    entries: Array<{ root: string; source: 'project' | 'user'; container: AgentContainer }>,
  ): DiscoveryRoot[] {
    return entries
  }

  it('keeps the first definition of a name and records what it shadowed', async () => {
    const projectRoot = await seed(
      'proj',
      '.copse',
      'reviewer.md',
      DEFINITION.replace('{where}', 'project'),
    )
    const userRoot = await seed(
      'home',
      '.claude',
      'reviewer.md',
      DEFINITION.replace('{where}', 'user'),
    )

    const result = await discoverAgentsFromRoots(
      rootsOf([
        { root: projectRoot, source: 'project', container: '.copse' },
        { root: userRoot, source: 'user', container: '.claude' },
      ]),
    )

    assert.equal(result.agents.length, 1)
    assert.equal(result.shadowed.length, 1)
    const [winner] = result.agents
    const [loser] = result.shadowed
    assert.ok(winner && loser)
    assert.equal(winner.description, 'from project')
    assert.equal(winner.source, 'project')
    assert.equal(loser.name, 'reviewer')
    assert.equal(loser.shadowedBy, join(projectRoot, 'reviewer.md'))
  })

  it('scans nested directories', async () => {
    const root = join(tempRoot, 'home', '.claude', 'agents')
    await mkdir(join(root, 'review'), { recursive: true })
    await writeFile(
      join(root, 'review', 'security.md'),
      ['---', 'name: security', 'description: d', '---', 'b'].join('\n'),
      'utf-8',
    )

    const result = await discoverAgentsFromRoots(
      rootsOf([{ root, source: 'user', container: '.claude' }]),
    )
    assert.deepEqual(
      result.agents.map((a) => a.name),
      ['security'],
    )
  })

  it('reports malformed definitions but stays silent about documentation', async () => {
    const root = await seed(
      'home',
      '.claude',
      'broken.md',
      ['---', 'name: -bad', '---', 'b'].join('\n'),
    )
    await writeFile(join(root, 'README.md'), '# Notes about my agents\n', 'utf-8')

    const result = await discoverAgentsFromRoots(
      rootsOf([{ root, source: 'user', container: '.claude' }]),
    )

    assert.equal(result.agents.length, 0)
    assert.equal(result.skipped.length, 1, 'README is documentation, not a skipped agent')
    assert.equal(result.skipped[0]?.agentPath, join(root, 'broken.md'))
  })

  it('orders project roots by container, then by depth', async () => {
    await mkdir(join(tempRoot, '.git'), { recursive: true })
    await seed('', '.claude', 'a.md', DEFINITION.replace('{where}', 'claude'))
    await seed('', '.copse', 'a.md', DEFINITION.replace('{where}', 'copse'))
    await seed(join('packages', 'inner'), '.copse', 'a.md', DEFINITION.replace('{where}', 'nested'))

    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    const roots = await runWithWorkspaceTrust(tempRoot, true, () => collectDiscoveryRoots())
    const project = roots.filter((r) => r.source === 'project')

    assert.deepEqual(
      project.map((r) => r.container),
      ['.copse', '.copse', '.claude'],
    )
    const [first, second] = project
    assert.ok(first && second)
    assert.ok(first.root.length < second.root.length, 'shallower .copse root comes first')
  })

  it('does not read project agents from an untrusted workspace', async () => {
    await mkdir(join(tempRoot, '.git'), { recursive: true })
    await seed('', '.claude', 'reviewer.md', DEFINITION.replace('{where}', 'project'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)

    const untrusted = await runWithWorkspaceTrust(tempRoot, false, () => collectDiscoveryRoots())
    assert.equal(
      untrusted.filter((r) => r.source === 'project').length,
      0,
      'a cloned repo must not arm its agents by being opened',
    )

    const trusted = await runWithWorkspaceTrust(tempRoot, true, () => collectDiscoveryRoots())
    assert.equal(trusted.filter((r) => r.source === 'project').length, 1)
  })

  it('does not rescan a nested checkout, so a worktree cannot duplicate every agent', async () => {
    await mkdir(join(tempRoot, '.git'), { recursive: true })
    await seed('', '.claude', 'reviewer.md', DEFINITION.replace('{where}', 'project'))

    // A worktree of the same repo, whose `.git` is a *file* rather than a directory.
    const worktree = join(tempRoot, '.claude', 'worktrees', 'branch')
    await mkdir(join(worktree, '.claude', 'agents'), { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere\n', 'utf-8')
    await writeFile(
      join(worktree, '.claude', 'agents', 'reviewer.md'),
      DEFINITION.replace('{where}', 'worktree'),
      'utf-8',
    )

    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    const roots = await runWithWorkspaceTrust(tempRoot, true, () => collectDiscoveryRoots())
    const project = roots.filter((r) => r.source === 'project')

    assert.equal(project.length, 1, 'the worktree copy must not be discovered')
    assert.equal(project[0]?.root, join(tempRoot, '.claude', 'agents'))
  })
})
