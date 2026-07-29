import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTerminalSession,
  __testInjectTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSessionsForThread,
  destroyTerminalSession,
  listTerminalSessions,
  resizeTerminalSession,
  writeTerminalSession,
  type TerminalWindow,
} from './terminal-service.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const OWNER = 1
const OTHER_OWNER = 2

function mockWindow(): TerminalWindow & {
  sent: Array<[string, ...unknown[]]>
  markDestroyed: () => void
} {
  let destroyed = false
  const sent: Array<[string, ...unknown[]]> = []
  const win = {
    isDestroyed: (): boolean => destroyed,
    webContents: {
      isDestroyed: (): boolean => destroyed,
      send(channel: string, ...args: unknown[]): void {
        sent.push([channel, ...args])
      },
    },
    markDestroyed(): void {
      destroyed = true
    },
    sent,
  }
  return win
}

async function ptySpawnAvailable(): Promise<boolean> {
  try {
    const win = mockWindow()
    const sessionId = await createTerminalSession(win, OWNER)
    destroyTerminalSession(sessionId, OWNER)
    return true
  } catch {
    return false
  }
}

describe('terminal-service', () => {
  afterEach(() => {
    destroyAllTerminalSessions()
  })

  it('creates a session and streams output', async (t) => {
    if (!(await ptySpawnAvailable())) {
      t.skip('PTY spawn unavailable in this environment')
      return
    }
    const restore = setWorkspaceRootForTest('/tmp')
    const win = mockWindow()
    let sessionId = ''
    try {
      sessionId = await createTerminalSession(win, OWNER)
      assert.ok(sessionId)
      writeTerminalSession(sessionId, OWNER, 'echo hello\n')
      await new Promise((r) => setTimeout(r, 300))
      const outputEvents = win.sent.filter(([ch]) => ch === 'terminal:output')
      assert.ok(outputEvents.length > 0)
      const combined = outputEvents.map(([, , data]) => data).join('')
      assert.match(combined, /hello/)
    } finally {
      if (sessionId) destroyTerminalSession(sessionId, OWNER)
      restore()
    }
  })

  it('starts a session in its explicit thread execution root', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX shell assertion')
      return
    }
    if (!(await ptySpawnAvailable())) {
      t.skip('PTY spawn unavailable in this environment')
      return
    }
    const projectRoot = await mkdtemp(join(tmpdir(), 'copse-terminal-project-'))
    const threadRoot = await mkdtemp(join(tmpdir(), 'copse-terminal-worktree-'))
    const restore = setWorkspaceRootForTest(projectRoot)
    const win = mockWindow()
    let sessionId = ''
    try {
      sessionId = await createTerminalSession(
        win,
        OWNER,
        80,
        24,
        { threadId: 'thread-1' },
        threadRoot,
      )
      writeTerminalSession(sessionId, OWNER, 'printf \'__COPSE_CWD__:%s\\n\' "$PWD"\n')
      await new Promise((resolve) => setTimeout(resolve, 300))
      const combined = win.sent
        .filter(([channel]) => channel === 'terminal:output')
        .map(([, , data]) => data)
        .join('')
      assert.match(combined, new RegExp(`__COPSE_CWD__:${threadRoot}`))
      assert.doesNotMatch(combined, new RegExp(`__COPSE_CWD__:${projectRoot}`))
    } finally {
      if (sessionId) destroyTerminalSession(sessionId, OWNER)
      restore()
      await rm(projectRoot, { recursive: true, force: true })
      await rm(threadRoot, { recursive: true, force: true })
    }
  })

  it('destroys a session', async (t) => {
    if (!(await ptySpawnAvailable())) {
      t.skip('PTY spawn unavailable in this environment')
      return
    }
    const restore = setWorkspaceRootForTest('/tmp')
    const win = mockWindow()
    let sessionId = ''
    try {
      sessionId = await createTerminalSession(win, OWNER)
      destroyTerminalSession(sessionId, OWNER)
      assert.throws(() => {
        writeTerminalSession(sessionId, OWNER, 'x')
      }, /Unknown terminal session/)
    } finally {
      restore()
    }
  })

  it('does not send output after the window is destroyed', async (t) => {
    if (!(await ptySpawnAvailable())) {
      t.skip('PTY spawn unavailable in this environment')
      return
    }
    const restore = setWorkspaceRootForTest('/tmp')
    const win = mockWindow()
    let sessionId = ''
    try {
      sessionId = await createTerminalSession(win, OWNER)
      writeTerminalSession(sessionId, OWNER, 'echo hello\n')
      await new Promise((r) => setTimeout(r, 300))
      const beforeDestroy = win.sent.filter(([ch]) => ch === 'terminal:output').length
      assert.ok(beforeDestroy > 0)

      win.markDestroyed()
      writeTerminalSession(sessionId, OWNER, 'echo again\n')
      await new Promise((r) => setTimeout(r, 300))
      const afterDestroy = win.sent.filter(([ch]) => ch === 'terminal:output').length
      assert.equal(afterDestroy, beforeDestroy)
    } finally {
      if (sessionId) destroyTerminalSession(sessionId, OWNER)
      restore()
    }
  })

  it('rejects write/resize/destroy from a non-owning renderer', async (t) => {
    if (!(await ptySpawnAvailable())) {
      t.skip('PTY spawn unavailable in this environment')
      return
    }
    const restore = setWorkspaceRootForTest('/tmp')
    const win = mockWindow()
    let sessionId = ''
    try {
      sessionId = await createTerminalSession(win, OWNER)
      assert.throws(() => {
        writeTerminalSession(sessionId, OTHER_OWNER, 'x')
      }, /not owned by the caller/)
      assert.throws(() => {
        resizeTerminalSession(sessionId, OTHER_OWNER, 80, 24)
      }, /not owned by the caller/)
      assert.throws(() => {
        destroyTerminalSession(sessionId, OTHER_OWNER)
      }, /not owned by the caller/)
      // The owner can still operate on its own session.
      writeTerminalSession(sessionId, OWNER, 'x')
    } finally {
      if (sessionId) destroyTerminalSession(sessionId, OWNER)
      restore()
    }
  })

  it('disposes only sessions owned by the requested thread', async () => {
    const first = __testInjectTerminalSession({
      ownerId: OWNER,
      label: 'First',
      threadId: 'thread-a',
      outputText: '',
    })
    const second = __testInjectTerminalSession({
      ownerId: OWNER,
      label: 'Second',
      threadId: 'thread-b',
      outputText: '',
    })
    __testInjectTerminalSession({
      ownerId: OWNER,
      label: 'Unscoped',
      threadId: null,
      outputText: '',
    })

    assert.deepEqual(await destroyTerminalSessionsForThread('thread-a'), [first])
    assert.equal(listTerminalSessions('thread-a').length, 0)
    assert.deepEqual(
      listTerminalSessions('thread-b').map((session) => session.id),
      [second],
    )
    assert.equal(listTerminalSessions(null).length, 1)
  })
})
