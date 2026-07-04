import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProjectInstructions, loadProjectInstructionSources } from './project-instructions.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('project-instructions', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | null = null

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-instructions-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
  })

  afterEach(async () => {
    restoreWorkspace?.()
    restoreWorkspace = null
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('returns empty when no instruction files exist', async () => {
    assert.equal(await loadProjectInstructions(), '')
    assert.deepEqual(await loadProjectInstructionSources(), [])
  })

  it('loads AGENT.md', async () => {
    await writeFile(join(tempRoot, 'AGENT.md'), '  Use tabs.  \n')
    assert.equal(await loadProjectInstructions(), 'Use tabs.')
    const sources = await loadProjectInstructionSources()
    assert.deepEqual(sources, [
      { path: join(tempRoot, 'AGENT.md'), name: 'AGENT.md', content: 'Use tabs.' },
    ])
  })

  it('loads CLAUDE.md for Claude parity', async () => {
    await writeFile(join(tempRoot, 'CLAUDE.md'), 'Prefer small PRs.')
    assert.equal(await loadProjectInstructions(), 'Prefer small PRs.')
    const sources = await loadProjectInstructionSources()
    assert.equal(sources[0]?.name, 'CLAUDE.md')
  })

  it('concatenates distinct files in precedence order', async () => {
    await writeFile(join(tempRoot, 'AGENT.md'), 'A')
    await writeFile(join(tempRoot, 'AGENTS.md'), 'B')
    await writeFile(join(tempRoot, 'CLAUDE.md'), 'C')
    assert.equal(await loadProjectInstructions(), 'A\n\nB\n\nC')
    const names = (await loadProjectInstructionSources()).map((s) => s.name)
    assert.deepEqual(names, ['AGENT.md', 'AGENTS.md', 'CLAUDE.md'])
  })

  it('de-duplicates identical content (e.g. AGENTS.md symlinked to CLAUDE.md)', async () => {
    await writeFile(join(tempRoot, 'AGENTS.md'), 'Same rules.')
    await writeFile(join(tempRoot, 'CLAUDE.md'), 'Same rules.')
    assert.equal(await loadProjectInstructions(), 'Same rules.')
    const sources = await loadProjectInstructionSources()
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.name, 'AGENTS.md')
  })

  it('skips empty / whitespace-only files', async () => {
    await writeFile(join(tempRoot, 'AGENT.md'), '   \n\n')
    await writeFile(join(tempRoot, 'CLAUDE.md'), 'Real content.')
    const sources = await loadProjectInstructionSources()
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.name, 'CLAUDE.md')
  })
})
