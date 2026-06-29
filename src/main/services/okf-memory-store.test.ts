import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  loadMemories,
  memoriesDir,
  saveMemory,
  searchMemories,
  setMemoriesRootForTest,
} from './okf-memory-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('okf-memory-store', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'okf-memories-'))
    setMemoriesRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setMemoriesRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it('saves a memory as an OKF markdown note and reads it back', () => {
    const saved = saveMemory({
      title: 'Build command',
      content: '# Build\nRun `npm run check` before committing.',
      tags: ['build', 'ci'],
    })

    assert.equal(saved.title, 'Build command')
    // First non-empty content line (heading stripped) becomes the description.
    assert.equal(saved.description, 'Build')
    assert.deepEqual(saved.tags, ['build', 'ci'])
    assert.ok(saved.file.endsWith('build-command.md'))

    const raw = readFileSync(saved.file, 'utf-8')
    assert.match(raw, /^---\n/)
    assert.match(raw, /^type: Memory$/m)
    assert.match(raw, /^title: "Build command"$/m)
    assert.match(raw, /^tags: \[build, ci\]$/m)
    assert.match(raw, /Run `npm run check` before committing\./)

    const [loaded] = loadMemories()
    assert.ok(loaded)
    assert.equal(loaded.title, 'Build command')
    assert.deepEqual(loaded.tags, ['build', 'ci'])
    assert.match(loaded.body, /Run `npm run check`/)
  })

  it('scopes memories per workspace', () => {
    saveMemory({ title: 'Project A note', content: 'belongs to project A' })

    const restoreB = setWorkspaceRootForTest('/home/dev/other-project')
    try {
      assert.equal(loadMemories().length, 0, 'other project starts empty')
      saveMemory({ title: 'Project B note', content: 'belongs to project B' })
      assert.deepEqual(
        loadMemories().map((m) => m.title),
        ['Project B note'],
      )
    } finally {
      restoreB()
    }

    assert.deepEqual(
      loadMemories().map((m) => m.title),
      ['Project A note'],
    )
    // Two distinct namespace directories under the shared root.
    assert.equal(readdirSync(root).length, 2)
  })

  it('updates an existing memory when the title is reused', () => {
    saveMemory({ title: 'Deploy', content: 'first version' })
    saveMemory({ title: 'Deploy', content: 'second version' })

    const memories = loadMemories()
    assert.equal(memories.length, 1)
    assert.match(at(memories, 0).body, /second version/)
    assert.equal(readdirSync(memoriesDir()).length, 1)
  })

  it('searches across titles, tags, and bodies (all terms must match)', () => {
    saveMemory({ title: 'Auth flow', content: 'uses OAuth tokens', tags: ['security'] })
    saveMemory({ title: 'Caching', content: 'redis cache layer', tags: ['perf'] })

    assert.deepEqual(
      searchMemories('oauth').map((m) => m.title),
      ['Auth flow'],
    )
    assert.deepEqual(
      searchMemories('security').map((m) => m.title),
      ['Auth flow'],
    )
    assert.equal(searchMemories('oauth redis').length, 0)
    assert.equal(searchMemories('').length, 2)
  })

  it('returns an empty list when no memories directory exists yet', () => {
    assert.deepEqual(loadMemories(), [])
  })

  it('rejects empty titles and content', () => {
    assert.throws(() => saveMemory({ title: '  ', content: 'x' }), /title is required/)
    assert.throws(() => saveMemory({ title: 'x', content: '   ' }), /content is required/)
  })
})
