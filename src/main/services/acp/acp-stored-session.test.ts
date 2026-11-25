import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadAcpSessionBinding,
  saveAcpSessionBinding,
  type AcpSessionBinding,
} from '../thread-store.ts'
import { threadAcpStoredSession } from './acp-stored-session.ts'

const BINDING: AcpSessionBinding = {
  v: 1,
  agentId: 'claude-agent-acp',
  sessionId: 'cli-session',
  protocolVersion: 1,
  executionTarget: { kind: 'local' },
  workspaceIdentity: '/repo',
  agentConfigGeneration: 0,
  createdBy: 'external',
  lastAttachedAt: 1,
}

describe('a thread’s saved ACP session link', () => {
  let root: string
  let previousRoot: string | undefined
  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-acp-stored-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })
  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('offers the session to the same agent, under a legacy id too, and keeps it after a resume', async () => {
    await saveAcpSessionBinding('p', 't', BINDING)
    const link = threadAcpStoredSession('p', 't', 'claude-acp')

    assert.deepEqual(await link.load(), { sessionId: 'cli-session', cwd: '/repo' })
    await link.keep('cli-session')

    const kept = await loadAcpSessionBinding('p', 't')
    assert.ok(kept)
    assert.equal(kept.sessionId, 'cli-session')
    assert.ok(kept.lastAttachedAt > 1)
  })

  it('never offers one agent’s session to another', async () => {
    await saveAcpSessionBinding('p', 't', BINDING)
    assert.equal(await threadAcpStoredSession('p', 't', 'codex-acp').load(), null)
  })

  it('forgets the link once the agent could not take it back', async () => {
    await saveAcpSessionBinding('p', 't', BINDING)
    await threadAcpStoredSession('p', 't', 'claude-acp').drop()
    assert.equal(await loadAcpSessionBinding('p', 't'), null)
  })
})
