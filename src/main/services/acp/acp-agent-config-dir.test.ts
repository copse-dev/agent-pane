import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acpAgentConfigDir, ensureAcpAgentConfigDir } from './acp-agent-config-dir.ts'

describe('acpAgentConfigDir', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-acp-config-dir-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('scopes the path to the thread and agent, beside events.jsonl', () => {
    const dir = acpAgentConfigDir('proj', 'thread-1', 'claude-acp')
    assert.equal(dir, join(root, 'proj', 'thread-1', 'acp-agent-config', 'claude-acp'))
  })

  it('gives two agents on the same thread distinct directories', () => {
    const a = acpAgentConfigDir('proj', 'thread-1', 'claude-acp')
    const b = acpAgentConfigDir('proj', 'thread-1', 'my-claude')
    assert.notEqual(a, b)
  })

  it('gives the same agent on two different threads distinct directories', () => {
    const a = acpAgentConfigDir('proj', 'thread-1', 'claude-acp')
    const b = acpAgentConfigDir('proj', 'thread-2', 'claude-acp')
    assert.notEqual(a, b)
  })

  it('rejects a thread id that would escape the project store', () => {
    assert.throws(() => acpAgentConfigDir('proj', '../escape', 'claude-acp'))
  })

  it('creates the directory so the agent can write into it immediately', async () => {
    const dir = await ensureAcpAgentConfigDir('proj', 'thread-1', 'claude-acp')
    assert.ok(existsSync(dir))
  })
})
