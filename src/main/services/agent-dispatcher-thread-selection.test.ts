import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { threadWith } from '@shared/store/transcript-stream.test-support.ts'
import { loadThreadSelection } from './agent-dispatcher.ts'
import { createThread, threadDirectoryPath, updateMeta } from './thread-store.ts'

const PROJECT = 'project-1'
const THREAD = 'thread-1'

describe('loadThreadSelection', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(async () => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-thread-selection-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    await createThread(PROJECT, threadWith(THREAD))
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('reads the model, reasoning dial and execution mode the chat saved', async () => {
    await updateMeta(PROJECT, THREAD, {
      model: 'lmstudio:qwen3-coder',
      reasoning: 'high',
      executionMode: 'agent',
    })
    assert.deepEqual(await loadThreadSelection(PROJECT, THREAD), {
      model: 'lmstudio:qwen3-coder',
      reasoning: 'high',
      executionMode: 'agent',
    })
  })

  it('names nothing for a chat on the global default', async () => {
    assert.deepEqual(await loadThreadSelection(PROJECT, THREAD), {})
  })

  it('drops a saved model or reasoning level the renderer would not send', async () => {
    const metaPath = join(threadDirectoryPath(PROJECT, THREAD), 'meta.json')
    const meta: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.ok(typeof meta === 'object' && meta !== null)
    writeFileSync(metaPath, JSON.stringify({ ...meta, model: 42, reasoning: 'loud' }))
    assert.deepEqual(await loadThreadSelection(PROJECT, THREAD), {})
  })

  it('is null for a thread with no saved metadata', async () => {
    assert.equal(await loadThreadSelection(PROJECT, 'no-such-thread'), null)
  })
})
