import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProjectInstructions, loadProjectInstructionSources } from './project-instructions.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('project-instructions', () => {
  let projectRoot = ''
  let homeRoot = ''
  let restoreWorkspace: (() => void) | null = null
  let originalHome: string | undefined

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'copse-panel-instructions-'))
    homeRoot = await mkdtemp(join(tmpdir(), 'copse-panel-home-'))
    restoreWorkspace = setWorkspaceRootForTest(projectRoot)
    originalHome = process.env['HOME']
    process.env['HOME'] = homeRoot
  })

  afterEach(async () => {
    restoreWorkspace?.()
    restoreWorkspace = null
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    else delete process.env['HOME']
    await rm(projectRoot, { recursive: true, force: true })
    await rm(homeRoot, { recursive: true, force: true })
  })

  it('returns empty when no instruction files exist', async () => {
    assert.equal(await loadProjectInstructions(), '')
    assert.deepEqual(await loadProjectInstructionSources(), [])
  })

  it('loads a project AGENT.md', async () => {
    await writeFile(join(projectRoot, 'AGENT.md'), '  Use tabs.  \n')
    assert.equal(await loadProjectInstructions(), 'Use tabs.')
    assert.deepEqual(await loadProjectInstructionSources(), [
      {
        path: join(projectRoot, 'AGENT.md'),
        name: 'AGENT.md',
        scope: 'project',
        content: 'Use tabs.',
      },
    ])
  })

  it('loads a project CLAUDE.md for Claude parity', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), 'Prefer small PRs.')
    const sources = await loadProjectInstructionSources()
    assert.deepEqual(
      sources.map((s) => ({ name: s.name, scope: s.scope })),
      [{ name: 'CLAUDE.md', scope: 'project' }],
    )
  })

  it('loads global ~/AGENTS.md and ~/.claude/CLAUDE.md', async () => {
    await writeFile(join(homeRoot, 'AGENTS.md'), 'Global A')
    await mkdir(join(homeRoot, '.claude'), { recursive: true })
    await writeFile(join(homeRoot, '.claude', 'CLAUDE.md'), 'Global C')
    const sources = await loadProjectInstructionSources()
    assert.deepEqual(
      sources.map((s) => ({ name: s.name, scope: s.scope, content: s.content })),
      [
        { name: 'AGENTS.md', scope: 'global', content: 'Global A' },
        { name: join('.claude', 'CLAUDE.md'), scope: 'global', content: 'Global C' },
      ],
    )
  })

  it('layers global before project', async () => {
    await writeFile(join(homeRoot, 'AGENTS.md'), 'Global rules')
    await writeFile(join(projectRoot, 'AGENT.md'), 'Project rules')
    assert.equal(await loadProjectInstructions(), 'Global rules\n\nProject rules')
    const scopes = (await loadProjectInstructionSources()).map((s) => s.scope)
    assert.deepEqual(scopes, ['global', 'project'])
  })

  it('concatenates distinct project files in precedence order', async () => {
    await writeFile(join(projectRoot, 'AGENT.md'), 'A')
    await writeFile(join(projectRoot, 'AGENTS.md'), 'B')
    await writeFile(join(projectRoot, 'CLAUDE.md'), 'C')
    assert.equal(await loadProjectInstructions(), 'A\n\nB\n\nC')
    const names = (await loadProjectInstructionSources()).map((s) => s.name)
    assert.deepEqual(names, ['AGENT.md', 'AGENTS.md', 'CLAUDE.md'])
  })

  it('de-duplicates identical content across files and scopes', async () => {
    // A repo whose AGENTS.md matches the user's global file must not inject twice.
    await writeFile(join(homeRoot, 'AGENTS.md'), 'Same rules.')
    await writeFile(join(projectRoot, 'AGENTS.md'), 'Same rules.')
    await writeFile(join(projectRoot, 'CLAUDE.md'), 'Same rules.')
    assert.equal(await loadProjectInstructions(), 'Same rules.')
    const sources = await loadProjectInstructionSources()
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.scope, 'global')
  })

  it('skips empty / whitespace-only files', async () => {
    await writeFile(join(projectRoot, 'AGENT.md'), '   \n\n')
    await writeFile(join(projectRoot, 'CLAUDE.md'), 'Real content.')
    const sources = await loadProjectInstructionSources()
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.name, 'CLAUDE.md')
  })

  it('loads global files even with no workspace open', async () => {
    restoreWorkspace?.()
    restoreWorkspace = setWorkspaceRootForTest(null)
    await writeFile(join(homeRoot, 'AGENTS.md'), 'Global only')
    assert.equal(await loadProjectInstructions(), 'Global only')
  })
})
