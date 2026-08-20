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
  destroyTerminalSessionsForOwner,
  destroyTerminalSession,
  listTerminalSessions,
  resizeTerminalSession,
  writeTerminalSession,
  type TerminalOwner,
} from './terminal-service.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const OWNER = 1
const OTHER_OWNER = 2

function mockWindow(id: number = OWNER): TerminalOwner & {
  sent: Array<[string, ...unknown[]]>
  markDestroyed: () => void
} {
  let destroyed = false
  const sent: Array<[string, ...unknown[]]> = []
  return {
    id,
    isDestroyed: (): boolean => destroyed,
    send(channel: string, ...args: unknown[]): void {
      sent.push([channel, ...args])
    },
    markDestroyed(): void {
      destroyed = true
    },
    sent,
  }
}

/**
 * Collect `terminal:output` until `pattern` shows up, rather than sleeping a
 * fixed interval and hoping.
 *
 * A pty echoes the command as soon as it is written, so a short sleep reliably
 * captures the echo and just as reliably races the command's own output. That
 * is how run 31242246521 failed: the buffer held `printf '__COPSE_CWD__:%s\n'
 * "$PWD"` — the echo verbatim — and none of the output the assertion wanted,
 * because the shell had not finished starting inside 300ms on a loaded runner.
 *
 * Returns the buffer as-is on timeout instead of throwing, so the caller's
 * assertion is still what reports the failure and its diff carries everything
 * the terminal actually emitted.
 */
async function waitForTerminalOutput(
  win: ReturnType<typeof mockWindow>,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const combined = win.sent
      .filter(([channel]) => channel === 'terminal:output')
      .map(([, , data]) => data)
      .join('')
    if (pattern.test(combined) || Date.now() >= deadline) return combined
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function ptySpawnAvailable(): Promise<boolean> {
  try {
    const win = mockWindow()
    const sessionId = await createTerminalSession(win)
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
      sessionId = await createTerminalSession(win)
      assert.ok(sessionId)
      writeTerminalSession(sessionId, OWNER, 'echo hello\n')
      // Same race as the thread-root test below: `hello` appears twice, once as
      // the echo and once as the output, so this only needs the echo to have
      // landed — but a 300ms sleep is not what guarantees that.
      const combined = await waitForTerminalOutput(win, /hello/)
      assert.ok(win.sent.filter(([ch]) => ch === 'terminal:output').length > 0)
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
      sessionId = await createTerminalSession(win, 80, 24, { threadId: 'thread-1' }, threadRoot)
      writeTerminalSession(sessionId, OWNER, 'printf \'__COPSE_CWD__:%s\\n\' "$PWD"\n')
      // Wait for the marker followed by a path, which only the *output* has —
      // the echoed command still carries the literal `%s`. So a shell that
      // started in the wrong directory prints its marker and fails immediately
      // on the assertion below, rather than burning the whole timeout first.
      const combined = await waitForTerminalOutput(win, /__COPSE_CWD__:\//)
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
      sessionId = await createTerminalSession(win)
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
      sessionId = await createTerminalSession(win)
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
      sessionId = await createTerminalSession(win)
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

  it('sends output only to the renderer that opened the session', async (t) => {
    // #1705: every terminal op was keyed on the calling renderer, but output
    // went to the single window captured at `initTerminal`. A pane pop-out
    // could open a shell and type into it while its output was posted to the
    // main window, which had no tab for that session and dropped it.
    if (!(await ptySpawnAvailable())) {
      t.skip('PTY spawn unavailable in this environment')
      return
    }
    const restore = setWorkspaceRootForTest('/tmp')
    const popout = mockWindow(OWNER)
    const mainWindow = mockWindow(OTHER_OWNER)
    let sessionId = ''
    try {
      sessionId = await createTerminalSession(popout)
      writeTerminalSession(sessionId, OWNER, 'echo popout-only\n')
      const combined = await waitForTerminalOutput(popout, /popout-only/)

      assert.match(combined, /popout-only/, 'the opening window receives its shell output')
      assert.equal(
        mainWindow.sent.length,
        0,
        'a shell must not replay into a window that did not open it',
      )
    } finally {
      if (sessionId) destroyTerminalSession(sessionId, OWNER)
      restore()
    }
  })

  it('kills a renderer’s sessions when that renderer goes away', () => {
    // A pop-out is a real window that closes on its own; only the main window's
    // `close` was wired to teardown, so its shells leaked as orphaned ptys.
    const popoutSession = __testInjectTerminalSession({
      ownerId: OWNER,
      label: 'Pop-out shell',
      threadId: 'thread-a',
      outputText: '',
    })
    const mainSession = __testInjectTerminalSession({
      ownerId: OTHER_OWNER,
      label: 'Main shell',
      threadId: 'thread-a',
      outputText: '',
    })

    destroyTerminalSessionsForOwner(OWNER)

    const remaining = listTerminalSessions('thread-a').map((session) => session.id)
    assert.deepEqual(remaining, [mainSession], 'only the closed renderer loses its shells')
    assert.ok(!remaining.includes(popoutSession))
  })
})
