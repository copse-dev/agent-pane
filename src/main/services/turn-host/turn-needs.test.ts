import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setSetting } from '../storage/settings.ts'
import { saveProjectThread } from '../thread-store.ts'
import { turnNeeds } from './turn-needs.ts'

let root = ''
const savedDir = process.env['COPSE_DIR']
before(() => {
  root = mkdtempSync(join(tmpdir(), 'turn-needs-'))
  process.env['COPSE_DIR'] = root
})
after(() => {
  if (savedDir === undefined) delete process.env['COPSE_DIR']
  else process.env['COPSE_DIR'] = savedDir
  rmSync(root, { recursive: true, force: true })
})

describe('turnNeeds', () => {
  it("reads the turn's model as the turn does: the prompt's, the thread's, then the default", async () => {
    await setSetting('model', 'claude-haiku-4-5')
    await saveProjectThread('p1', {
      id: 't1',
      title: 'Plan',
      status: 'idle',
      model: 'acp:codex',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    })
    assert.equal((await turnNeeds('p1', 't1', 'claude-sonnet-4-6')).model, 'claude-sonnet-4-6')
    assert.equal((await turnNeeds('p1', 't1', undefined)).model, 'acp:codex')
    const fresh = await turnNeeds('p1', 'no-such-thread', undefined)
    assert.equal(fresh.model, 'claude-haiku-4-5')
    // No plugin with its own runtime is on, and nothing confines commands here.
    assert.equal(fresh.pluginRuntimes, false)
    assert.equal(fresh.sandbox, false)
  })
})
