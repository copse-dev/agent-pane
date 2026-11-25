import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMMessage, Thread } from '@shared/types'
import { claudeProjectDirName } from './claude-code-sessions.ts'
import {
  importExternalSessions,
  listExternalSessions,
  type ExternalSessionImportDeps,
} from './external-session-import.ts'

let scratch: string
const ROOT = '/Users/dev/code/my-app'

interface Harness {
  deps: ExternalSessionImportDeps
  threads: Thread[]
  bindings: Array<{
    threadId: string
    agentId: string
    sessionId: string
    cwd: string
    history: readonly LLMMessage[]
    sharedFile?: { path: string; modifiedAt: number }
  }>
  histories: Map<string, LLMMessage[]>
}

function harness(enabledAgents: string[], options: { claudeScoped?: boolean } = {}): Harness {
  const threads: Thread[] = []
  const bindings: Harness['bindings'] = []
  const histories = new Map<string, LLMMessage[]>()
  return {
    threads,
    bindings,
    histories,
    deps: {
      projectRoot: (id) => (id === 'p1' ? ROOT : null),
      loadThreadMetas: (): Promise<Thread[]> =>
        Promise.resolve(threads.map((thread) => ({ ...thread, messages: [] }))),
      createThread: (_projectId, thread): Promise<void> => {
        threads.push(thread)
        return Promise.resolve()
      },
      findAgent: (id) =>
        Promise.resolve(
          enabledAgents.includes(id)
            ? { id, sessionsStayInThread: options.claudeScoped ?? true }
            : null,
        ),
      saveHistory: (_projectId, threadId, history): Promise<void> => {
        histories.set(threadId, history)
        return Promise.resolve()
      },
      claudeThreadConfigDir: (_projectId, threadId, agentId) =>
        join(scratch, 'threads', threadId, agentId),
      saveBinding: (_projectId, threadId, binding): Promise<void> => {
        bindings.push({ threadId, ...binding })
        return Promise.resolve()
      },
      env: { CLAUDE_CONFIG_DIR: join(scratch, 'claude'), CODEX_HOME: join(scratch, 'codex') },
      now: () => 1_000,
    },
  }
}

function seedClaude(): string {
  const dir = join(scratch, 'claude', 'projects', claudeProjectDirName(ROOT))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'claude-session-1.jsonl')
  const line = (value: unknown): string => JSON.stringify(value)
  writeFileSync(
    path,
    [
      line({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'claude-session-1',
        cwd: ROOT,
        timestamp: '2026-11-01T10:00:00.000Z',
        message: { role: 'user', content: 'Fix the flaky test' },
      }),
      line({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        cwd: ROOT,
        timestamp: '2026-11-01T10:01:00.000Z',
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      }),
    ].join('\n'),
  )
  return path
}

function seedCodex(cwd: string): void {
  const dir = join(scratch, 'codex', 'sessions', '2026', '11', '02')
  mkdirSync(dir, { recursive: true })
  const at = (type: string, payload: unknown): string =>
    JSON.stringify({ timestamp: '2026-11-02T09:00:00.000Z', type, payload })
  writeFileSync(
    join(dir, 'rollout-2026-11-02T09-00-00-codex-1.jsonl'),
    [
      at('session_meta', {
        id: 'codex-1',
        timestamp: '2026-11-02T09:00:00.000Z',
        cwd,
        git: { branch: 'add-flag' },
      }),
      at('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Add a CLI flag' }],
      }),
    ].join('\n'),
  )
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'session-import-'))
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('importing Claude Code and Codex sessions', () => {
  it('lists only sessions that ran in the project, from both tools', async () => {
    seedClaude()
    seedCodex(join(ROOT, 'cli'))
    const { deps } = harness([])

    const list = await listExternalSessions(deps, 'p1')

    assert.deepEqual(list.sourcesFound, ['claude-code', 'codex'])
    assert.deepEqual(
      list.sessions.map((session) => [session.source, session.title, session.relativeCwd]).sort(),
      [
        ['claude-code', 'Fix the flaky test', ''],
        ['codex', 'Add a CLI flag', 'cli'],
      ],
    )
    for (const session of list.sessions) assert.match(session.key, /^[0-9a-f]{32}$/)
    assert.ok(
      list.sessions.every((session) => !JSON.stringify(session).includes('claude-session-1')),
      'the raw session id never leaves main',
    )
  })

  it('imports a Claude Code session as a thread its agent can resume', async () => {
    const original = seedClaude()
    const h = harness(['claude-acp'])
    const [session] = (await listExternalSessions(h.deps, 'p1')).sessions
    assert.ok(session)

    const result = await importExternalSessions(h.deps, 'p1', [session.key])

    assert.equal(result.imported.length, 1)
    const thread = result.imported[0]
    assert.ok(thread)
    assert.equal(thread.title, 'Fix the flaky test')
    assert.equal(thread.model, 'acp:claude-acp')
    assert.equal(thread.worktreeChoice, 'shared')
    assert.deepEqual(thread.importedSession, {
      source: 'claude-code',
      key: session.key,
      importedAt: 1_000,
    })
    assert.deepEqual(thread.messages, [], 'the renderer loads the transcript on open')
    assert.equal(thread.messagesLoaded, false)
    assert.deepEqual(
      h.threads[0]?.messages.map((message) => [message.role, message.content]),
      [
        ['user', 'Fix the flaky test'],
        ['assistant', 'Done.'],
      ],
    )
    // The model reads a labelled record, never the CLI's work as its own calls.
    const history = h.histories.get(thread.id)
    assert.deepEqual(history, [
      {
        role: 'user',
        content:
          "[This conversation was imported from Claude Code. Its earlier turns and tool calls ran in Claude Code, outside Copse's sandbox and approvals.]\n\nFix the flaky test",
      },
      { role: 'assistant', content: 'Done.' },
    ])
    // The binding carries that history, so a resume does not send it again.
    assert.deepEqual(h.bindings, [
      {
        threadId: thread.id,
        agentId: 'claude-acp',
        sessionId: 'claude-session-1',
        cwd: ROOT,
        history,
      },
    ])
    // The thread's agent gets its own copy where its scoped config dir looks.
    const copy = join(
      scratch,
      'threads',
      thread.id,
      'claude-acp',
      'projects',
      claudeProjectDirName(ROOT),
      'claude-session-1.jsonl',
    )
    assert.equal(readFileSync(copy, 'utf8'), readFileSync(original, 'utf8'))

    const again = await importExternalSessions(h.deps, 'p1', [session.key])
    assert.deepEqual(again.imported, [])
    assert.deepEqual(again.alreadyImported, [{ key: session.key, threadId: thread.id }])
    const relisted = await listExternalSessions(h.deps, 'p1')
    assert.equal(relisted.sessions[0]?.importedThreadId, thread.id)
  })

  it("does not link a Claude session its agent would resume in the user's own ~/.claude", async () => {
    seedClaude()
    const h = harness(['claude-acp'], { claudeScoped: false })
    const [session] = (await listExternalSessions(h.deps, 'p1')).sessions
    assert.ok(session)

    const result = await importExternalSessions(h.deps, 'p1', [session.key])

    const thread = result.imported[0]
    assert.ok(thread)
    assert.equal(thread.model, 'acp:claude-acp')
    assert.deepEqual(h.bindings, [])
    assert.equal(existsSync(join(scratch, 'threads')), false)
    assert.equal(h.histories.get(thread.id)?.length, 2)
  })

  it('links a Codex session to the rollout it shares with the CLI, as last written', async () => {
    seedCodex(ROOT)
    const h = harness(['codex-acp'])
    const [session] = (await listExternalSessions(h.deps, 'p1')).sessions
    assert.ok(session)

    const result = await importExternalSessions(h.deps, 'p1', [session.key])

    // The thread says its turns add to the user's own session.
    assert.equal(result.imported[0]?.importedSession?.sharesOriginal, true)
    const shared = h.bindings[0]?.sharedFile
    assert.ok(shared)
    assert.match(shared.path, /rollout-2026-11-02T09-00-00-codex-1\.jsonl$/)
    assert.equal(shared.modifiedAt, session.updatedAt)
  })

  it('imports the transcript alone when the matching agent is not set up', async () => {
    seedCodex(ROOT)
    const h = harness([])
    const [session] = (await listExternalSessions(h.deps, 'p1')).sessions
    assert.ok(session)

    const result = await importExternalSessions(h.deps, 'p1', [session.key])

    assert.equal(result.imported[0]?.model, undefined)
    assert.equal(result.imported[0]?.importedSession?.sharesOriginal, undefined)
    assert.equal(result.imported[0]?.gitBranch, 'add-flag')
    assert.deepEqual(h.bindings, [])
    assert.equal(existsSync(join(scratch, 'threads')), false)
  })

  it("does not tie a session from a folder inside the project to the checkout's branch", async () => {
    // Often a worktree of its own: its branch is checked out there, not here.
    seedCodex(join(ROOT, '.claude', 'worktrees', 'tidy'))
    const h = harness([])
    const [session] = (await listExternalSessions(h.deps, 'p1')).sessions
    assert.ok(session)

    const result = await importExternalSessions(h.deps, 'p1', [session.key])

    assert.equal(result.imported[0]?.gitBranch, undefined)
  })

  it('reports a key that no longer names a session', async () => {
    const h = harness([])
    const result = await importExternalSessions(h.deps, 'p1', ['0'.repeat(32)])
    assert.deepEqual(result.failed, [
      { key: '0'.repeat(32), reason: 'The session is no longer on this machine.' },
    ])
  })
})
