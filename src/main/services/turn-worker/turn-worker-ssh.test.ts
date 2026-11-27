import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { listDirTool } from '../../tools/file-tools.ts'
import { setSettings } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { loadThreadMessages, saveProjectThread } from '../thread-store.ts'
import { setSshControlDirForTests } from '../ssh-workspace/ssh-paths.ts'
import { runTurnWorker } from './turn-worker.ts'

/**
 * A turn handed off on an SSH project keeps running on the remote host
 * (`docs/plans/local-turn-worker.md`, SSH hosts). The worker opens its own
 * connection through the same OpenSSH path the app uses; here that is the e2e
 * suite's stub `ssh`, which runs remote commands in a local shell and records
 * that a control master was started.
 */

const saved = {
  dir: process.env['COPSE_DIR'],
  mock: process.env['COPSE_PANEL_MOCK_LLM'],
  path: process.env['PATH'],
  state: process.env['COPSE_E2E_FAKE_SSH_STATE'],
}
const scratch: string[] = []
function dir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

let state = ''
let remoteRoot = ''
before(() => {
  process.env['COPSE_DIR'] = dir('tw-ssh-')
  process.env['COPSE_PANEL_MOCK_LLM'] = '1'
  state = dir('tw-ssh-state-')
  remoteRoot = dir('tw-ssh-remote-')
  writeFileSync(join(remoteRoot, 'REMOTE_MARKER.txt'), 'on the host\n')
  process.env['PATH'] = [resolve('tests/e2e/fixtures/fake-ssh'), saved.path ?? ''].join(delimiter)
  process.env['COPSE_E2E_FAKE_SSH_STATE'] = state
  // Not the real per-user control directory a running Copse shares.
  // A short path under /tmp: control socket paths have a tight length limit.
  const control = mkdtempSync('/tmp/tw-ssh-ctl-')
  scratch.push(control)
  setSshControlDirForTests(control)
})
function restore(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key)
  else process.env[key] = value
}

after(() => {
  setSshControlDirForTests(null)
  restore('COPSE_DIR', saved.dir)
  restore('COPSE_PANEL_MOCK_LLM', saved.mock)
  restore('PATH', saved.path)
  restore('COPSE_E2E_FAKE_SSH_STATE', saved.state)
  for (const path of scratch) rmSync(path, { recursive: true, force: true })
})

describe('runTurnWorker on an SSH project', () => {
  it('continues the turn with tools running on the remote host', async () => {
    storageSet('projects', [{ id: 'sshp', path: remoteRoot, name: 'dev:app', sshHost: 'dev' }])
    await setSettings({
      sshWorkspaceEnabled: true,
      sshWorkspaceHosts: [{ id: 'dev', label: 'Dev', host: 'dev.example', user: 'ubuntu' }],
      model: 'claude-sonnet-4-6',
    })
    const at = Date.now() - 60_000
    // Cut off before the first answer: the mock provider's first step lists the root.
    await saveProjectThread('sshp', {
      id: 'tssh',
      title: 'List the files',
      status: 'running',
      model: 'claude-sonnet-4-6',
      messages: [
        { id: 'u1', role: 'user', content: 'List the files', toolCalls: [], createdAt: at },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: at,
      updatedAt: at,
    })
    const registry = new ToolRegistry()
    registry.register(listDirTool)

    const outcome = await runTurnWorker(
      { projectId: 'sshp', threadId: 'tssh' },
      { registry, log: () => undefined, handOffWaitMs: 0 },
    )

    assert.equal(outcome.status, 'continued')
    assert.ok(existsSync(join(state, 'master')), 'the worker connected over ssh')
    const messages = await loadThreadMessages('sshp', 'tssh')
    const listing = messages
      .flatMap((message) => message.toolCalls)
      .find((call) => call.name === 'list_dir')
    assert.ok(listing, 'the continued turn listed the project')
    assert.match(String(listing.result), /REMOTE_MARKER\.txt/)
  })
})
