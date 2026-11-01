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
  type EnvironmentSetupProject,
} from './environment-setup.ts'

let previousStore: string | undefined
let tmp: string
let workspace: string
let otherWorkspace: string
let ambientWorkspace: string
let project: EnvironmentSetupProject
let otherProject: EnvironmentSetupProject
let restoreRoot: () => void
let previousProject: unknown

/** Three approved escalations of `command` and three of a web origin per thread. */
function seedThreads(projectId: string, threadIds: readonly string[]): void {
  const now = Date.now()
  for (const threadId of threadIds) {
    const dir = join(tmp, 'store', projectId, threadId)
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
    otherWorkspace = join(tmp, 'other-project')
    ambientWorkspace = join(tmp, 'ambient-project')
    for (const dir of [workspace, otherWorkspace, ambientWorkspace]) {
      mkdirSync(dir, { recursive: true })
      setWorkspaceTrusted(dir, true)
    }
    project = { projectId: 'proj', root: workspace }
    otherProject = { projectId: 'proj2', root: otherWorkspace }
    // The process-global workspace names a third project with no history: the
    // service must use only the project it is given.
    restoreRoot = setWorkspaceRootForTest(ambientWorkspace)
    previousProject = storageGet('activeProjectId')
    storageSet('activeProjectId', 'ambient')
    seedThreads('proj', ['t1', 't2'])
    seedThreads('proj2', ['t3', 't4', 't5'])
  })

  after(() => {
    for (const dir of [workspace, otherWorkspace, ambientWorkspace]) {
      setWorkspaceTrusted(dir, false)
    }
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
    assert.deepEqual(await environmentSetupStatus(project), { offer: true, promptCount: 12 })
    await dismissEnvironmentSetup(false)
    assert.equal((await environmentSetupStatus(project)).offer, false)
  })

  it('stays hidden in an untrusted workspace', async () => {
    setWorkspaceTrusted(workspace, false)
    try {
      assert.deepEqual(await environmentSetupStatus(project), { offer: false, promptCount: 0 })
      assert.deepEqual((await reviewEnvironmentSetup(project)).suggestions, [])
    } finally {
      setWorkspaceTrusted(workspace, true)
    }
  })

  it('applies only ticked suggestions, with values computed in main', async () => {
    const review = await reviewEnvironmentSetup(project)
    const command = review.suggestions.find((s) => s.kind === 'trusted-command')
    const origin = review.suggestions.find((s) => s.kind === 'web-origin')
    assert.ok(command && origin)
    assert.equal(command.value, 'xcodebuild')
    assert.equal(command.checked, false)
    assert.equal(origin.checked, true)

    const result = await applyEnvironmentSetup('proj', review.reviewId, [origin.id, 'not-an-id'])
    assert.deepEqual(
      result.applied.map((change) => change.value),
      ['https://docs.example.com'],
    )
    assert.deepEqual(getSetting<string[]>('trustedShellCommands', []), [])
    assert.ok(getSetting<string[]>('webAllowedOrigins', []).includes('https://docs.example.com'))

    const log = (await storageReadFile('environment-setup.jsonl')) ?? ''
    assert.match(log, /"action":"apply".*"value":"https:\/\/docs.example.com"/)

    await assert.rejects(applyEnvironmentSetup('proj', review.reviewId, [command.id]), /expired/)
  })

  it('undoes exactly what it added and keeps later manual changes', async () => {
    const review = await reviewEnvironmentSetup(project)
    const ids = review.suggestions.map((s) => s.id)
    const { undoId } = await applyEnvironmentSetup('proj', review.reviewId, ids)
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

  it('resolves two projects concurrently, each from its own history and root', async () => {
    const [status, otherStatus] = await Promise.all([
      environmentSetupStatus(project),
      environmentSetupStatus(otherProject),
    ])
    assert.deepEqual(status, { offer: true, promptCount: 12 })
    assert.deepEqual(otherStatus, { offer: true, promptCount: 18 })

    setWorkspaceTrusted(otherWorkspace, false)
    try {
      const [review, otherReview] = await Promise.all([
        reviewEnvironmentSetup(project),
        reviewEnvironmentSetup(otherProject),
      ])
      assert.ok(review.suggestions.length > 0)
      // Trust is checked on the project's own root, not the ambient workspace.
      assert.deepEqual(otherReview.suggestions, [])
    } finally {
      setWorkspaceTrusted(otherWorkspace, true)
    }
  })

  it('keeps one review per project and applies it only for that project', async () => {
    const [review, otherReview] = await Promise.all([
      reviewEnvironmentSetup(project),
      reviewEnvironmentSetup(otherProject),
    ])
    const ids = review.suggestions.map((s) => s.id)
    await assert.rejects(applyEnvironmentSetup('proj2', review.reviewId, ids), /expired/)
    await assert.rejects(applyEnvironmentSetup(null, review.reviewId, ids), /expired/)

    // Reviewing the second project did not expire the first.
    const result = await applyEnvironmentSetup('proj', review.reviewId, ids)
    assert.deepEqual(result.applied.map((change) => change.value).sort(), [
      'https://docs.example.com',
      'xcodebuild',
    ])
    const otherIds = otherReview.suggestions.map((s) => s.id)
    const otherResult = await applyEnvironmentSetup('proj2', otherReview.reviewId, otherIds)
    // The first project's apply already added both values.
    assert.deepEqual(otherResult, { applied: [], undoId: null })
  })
})
