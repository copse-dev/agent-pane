import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getSetting, setSetting } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { storageReadFile, storageRemoveFile } from '../storage/user-data-files.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setWorkspaceTrusted } from './workspace-trust.ts'
import {
  applyEnvironmentSetup,
  dismissEnvironmentSetup,
  environmentSetupStatus,
  reviewEnvironmentSetup,
  undoEnvironmentSetup,
} from './environment-setup.ts'

let previousStore: string | undefined
let tmp: string
let workspace: string
let restoreRoot: () => void
let previousProject: unknown

/** Five approved escalations of `command` and five of a web origin, over two threads. */
function seedThreads(): void {
  const now = Date.now()
  for (const threadId of ['t1', 't2']) {
    const dir = join(tmp, 'store', 'proj', threadId)
    mkdirSync(dir, { recursive: true })
    const lines: unknown[] = []
    const calls: unknown[] = []
    for (let i = 0; i < 3; i++) {
      const id = `${threadId}-c${String(i)}`
      calls.push({
        id,
        name: 'run_shell',
        args: { command: 'xcodebuild -scheme App build' },
        status: 'done',
        result: null,
      })
      lines.push(
        {
          v: 1,
          type: 'decision',
          id: `${id}-d`,
          at: now,
          kind: 'shell',
          actor: 'user',
          verdict: 'approved',
          subject: 'shell command (arguments omitted)',
          cause: 'shell-sandbox-escalation',
          toolCallId: id,
        },
        {
          v: 1,
          type: 'decision',
          id: `${id}-w`,
          at: now,
          kind: 'web',
          actor: 'user',
          verdict: 'approved',
          subject: 'https://docs.example.com',
          cause: 'web-origin',
        },
      )
    }
    lines.push({
      v: 1,
      type: 'message',
      id: `${threadId}-m`,
      role: 'assistant',
      createdAt: now,
      content: { ref: 'messages/m.md', sha256: 'x' },
      toolCalls: calls,
    })
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    )
  }
}

describe('environment setup', () => {
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'copse-env-setup-'))
    previousStore = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = join(tmp, 'store')
    workspace = join(tmp, 'project')
    mkdirSync(workspace, { recursive: true })
    restoreRoot = setWorkspaceRootForTest(workspace)
    setWorkspaceTrusted(workspace, true)
    previousProject = storageGet('activeProjectId')
    storageSet('activeProjectId', 'proj')
    seedThreads()
  })

  after(() => {
    setWorkspaceTrusted(workspace, false)
    restoreRoot()
    storageSet('activeProjectId', previousProject)
    if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousStore
    rmSync(tmp, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await setSetting('trustedShellCommands', [])
    await setSetting('webAllowedOrigins', ['https://github.com'])
    await storageRemoveFile('environment-setup.json')
    await storageRemoveFile('environment-setup.jsonl')
  })

  it('offers itself once enough approved prompts would have been removed', async () => {
    assert.deepEqual(await environmentSetupStatus(), { offer: true, promptCount: 12 })
    await dismissEnvironmentSetup(false)
    assert.equal((await environmentSetupStatus()).offer, false)
  })

  it('stays hidden in an untrusted workspace', async () => {
    setWorkspaceTrusted(workspace, false)
    try {
      assert.deepEqual(await environmentSetupStatus(), { offer: false, promptCount: 0 })
      assert.deepEqual((await reviewEnvironmentSetup()).suggestions, [])
    } finally {
      setWorkspaceTrusted(workspace, true)
    }
  })

  it('applies only ticked suggestions, with values computed in main', async () => {
    const review = await reviewEnvironmentSetup()
    const command = review.suggestions.find((s) => s.kind === 'trusted-command')
    const origin = review.suggestions.find((s) => s.kind === 'web-origin')
    assert.ok(command && origin)
    assert.equal(command.value, 'xcodebuild')
    assert.equal(command.checked, false)
    assert.equal(origin.checked, true)

    const result = await applyEnvironmentSetup(review.reviewId, [origin.id, 'not-an-issued-id'])
    assert.deepEqual(
      result.applied.map((change) => change.value),
      ['https://docs.example.com'],
    )
    assert.deepEqual(getSetting<string[]>('trustedShellCommands', []), [])
    assert.ok(getSetting<string[]>('webAllowedOrigins', []).includes('https://docs.example.com'))

    const log = (await storageReadFile('environment-setup.jsonl')) ?? ''
    assert.match(log, /"action":"apply".*"value":"https:\/\/docs.example.com"/)

    await assert.rejects(applyEnvironmentSetup(review.reviewId, [command.id]), /expired/)
  })

  it('undoes exactly what it added and keeps later manual changes', async () => {
    const review = await reviewEnvironmentSetup()
    const ids = review.suggestions.map((s) => s.id)
    const { undoId } = await applyEnvironmentSetup(review.reviewId, ids)
    assert.ok(undoId)
    assert.deepEqual(getSetting<string[]>('trustedShellCommands', []), ['xcodebuild'])

    // The user adds a value by hand between apply and undo.
    await setSetting('trustedShellCommands', ['xcodebuild', 'swift'])

    const undone = await undoEnvironmentSetup(undoId)
    assert.equal(undone.length, 2)
    assert.deepEqual(getSetting<string[]>('trustedShellCommands', []), ['swift'])
    assert.ok(!getSetting<string[]>('webAllowedOrigins', []).includes('https://docs.example.com'))
    assert.deepEqual(await undoEnvironmentSetup(undoId), [])
  })
})
