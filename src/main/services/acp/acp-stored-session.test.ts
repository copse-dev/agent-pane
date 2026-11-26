import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadAcpSessionBinding,
  saveAcpSessionBinding,
  type AcpSessionBinding,
} from '../thread-store.ts'
import { acpAgentConfigDir } from './acp-agent-config-dir.ts'
import { recordStoredSessionCheckpoint, threadAcpStoredSession } from './acp-stored-session.ts'

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
    const link = threadAcpStoredSession('p', 't', 'claude-acp', {
      claudeConfigDir: acpAgentConfigDir('p', 't', 'claude-acp'),
    })

    assert.deepEqual(await link.load(), { sessionId: 'cli-session', cwd: '/repo' })
    await link.keep('cli-session')

    const kept = await loadAcpSessionBinding('p', 't')
    assert.ok(kept)
    assert.equal(kept.sessionId, 'cli-session')
    assert.ok(kept.lastAttachedAt > 1)
  })

  it('keeps an imported Claude session from a turn that would resume the user’s original', async () => {
    await saveAcpSessionBinding('p', 't', BINDING)
    // No scoped config dir: the CLI would open ~/.claude's file and write to it.
    assert.equal(await threadAcpStoredSession('p', 't', 'claude-acp').load(), null)
    assert.equal(
      await threadAcpStoredSession('p', 't', 'claude-acp', {
        claudeConfigDir: '/Users/dev/.claude',
      }).load(),
      null,
    )
  })

  it('hands back the history the session already holds, as of the last turn', async () => {
    await saveAcpSessionBinding('p', 't', {
      ...BINDING,
      agentId: 'codex-acp',
      transcriptCheckpoint: { messageCount: 2, prefixHash: 'a' },
    })
    const link = threadAcpStoredSession('p', 't', 'codex-acp')
    assert.deepEqual((await link.load())?.transcriptCheckpoint, {
      messageCount: 2,
      prefixHash: 'a',
    })

    await recordStoredSessionCheckpoint('p', 't', 'codex-acp', { messageCount: 4, prefixHash: 'b' })
    assert.deepEqual((await loadAcpSessionBinding('p', 't'))?.transcriptCheckpoint, {
      messageCount: 4,
      prefixHash: 'b',
    })
    // Another agent's turn leaves the link alone.
    await recordStoredSessionCheckpoint('p', 't', 'claude-acp', {
      messageCount: 6,
      prefixHash: 'c',
    })
    assert.equal((await loadAcpSessionBinding('p', 't'))?.transcriptCheckpoint?.prefixHash, 'b')
  })

  it('lets a Codex session go once the CLI carried it on after the import', async () => {
    const rollout = join(root, 'rollout.jsonl')
    writeFileSync(rollout, '{}\n')
    const importedAt = Date.now() - 60_000
    utimesSync(rollout, importedAt / 1000, importedAt / 1000)
    const binding: AcpSessionBinding = {
      ...BINDING,
      agentId: 'codex-acp',
      sharedSessionFile: { path: rollout, modifiedAt: importedAt },
    }
    await saveAcpSessionBinding('p', 't', binding)
    assert.equal(
      (await threadAcpStoredSession('p', 't', 'codex-acp').load())?.sessionId,
      'cli-session',
    )

    // The user went on in the CLI.
    utimesSync(rollout, new Date(), new Date())
    assert.equal(await threadAcpStoredSession('p', 't', 'codex-acp').load(), null)
    assert.equal(await loadAcpSessionBinding('p', 't'), null)
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
