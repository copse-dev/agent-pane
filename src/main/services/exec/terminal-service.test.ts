import { describe, it, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTerminalSession,
  terminalHistoryEnv,
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
import { projectStoreDir } from '../storage/copse-paths.ts'
import { setSetting } from '../storage/settings.ts'
import {
  fishHistorySessionName,
  SHARE_TERMINAL_HISTORY_ENABLED_DEFAULT,
  SHARE_TERMINAL_HISTORY_ENABLED_SETTING,
  TERMINAL_HISTORY_FILENAME,
} from '@shared/terminal/terminal-history.ts'

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

describe('terminal history sharing (#2433)', () => {
  // `terminalHistoryEnv` creates the per-project store directory on disk, so
  // point it at a throwaway root rather than a developer's real `~/.copse`.
  let historyRoot = ''
  let prevWorkspaceDir: string | undefined

  before(async () => {
    historyRoot = await mkdtemp(join(tmpdir(), 'copse-terminal-history-'))
    prevWorkspaceDir = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = historyRoot
  })

  after(async () => {
    if (prevWorkspaceDir === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = prevWorkspaceDir
    await rm(historyRoot, { recursive: true, force: true })
  })

  it('gives two threads of the same project the same HISTFILE, creating the directory', () => {
    const first = terminalHistoryEnv('/bin/bash', 'project-shared')
    const second = terminalHistoryEnv('/bin/bash', 'project-shared')
    assert.ok(first['HISTFILE'])
    assert.equal(first['HISTFILE'], second['HISTFILE'])
    assert.equal(
      first['HISTFILE'],
      join(projectStoreDir('project-shared'), TERMINAL_HISTORY_FILENAME),
    )
    assert.ok(existsSync(projectStoreDir('project-shared')))
  })

  it('gives different projects different HISTFILE paths', () => {
    const a = terminalHistoryEnv('/bin/bash', 'project-a')
    const b = terminalHistoryEnv('/bin/bash', 'project-b')
    assert.notEqual(a['HISTFILE'], b['HISTFILE'])
  })

  it('fills in bash history knobs only where the base env leaves them unset', () => {
    const withoutOverrides = terminalHistoryEnv('/bin/bash', 'project-bash', {})
    assert.equal(withoutOverrides['HISTCONTROL'], 'ignoredups:erasedups')
    assert.equal(withoutOverrides['HISTSIZE'], '10000')
    assert.equal(withoutOverrides['HISTFILESIZE'], '20000')

    // When the base env already has these set, the function leaves them out of
    // its own additions entirely — the caller spreads its result over the base
    // env (never the other way around), so an *absent* key here is what
    // preserves the user's own value in the final spawn env.
    const withOverrides = terminalHistoryEnv('/bin/bash', 'project-bash', {
      HISTCONTROL: 'ignorespace',
      HISTSIZE: '500',
      HISTFILESIZE: '500',
    })
    assert.equal(withOverrides['HISTCONTROL'], undefined)
    assert.equal(withOverrides['HISTSIZE'], undefined)
    assert.equal(withOverrides['HISTFILESIZE'], undefined)
    // The shared HISTFILE itself always wins — that is the point of the feature.
    assert.ok(withOverrides['HISTFILE'])
  })

  it('sets HISTFILE for zsh without the bash-only knobs', () => {
    const env = terminalHistoryEnv('/usr/bin/zsh', 'project-zsh')
    assert.ok(env['HISTFILE'])
    assert.equal(env['HISTCONTROL'], undefined)
    assert.equal(env['HISTSIZE'], undefined)
  })

  it('uses a per-project fish_history session name for fish instead of HISTFILE', () => {
    const env = terminalHistoryEnv('/usr/bin/fish', 'project-fish')
    assert.equal(env['fish_history'], fishHistorySessionName('project-fish'))
    assert.equal(env['HISTFILE'], undefined)
  })

  it('leaves agent/tool shells (no projectId) untouched', () => {
    assert.deepEqual(terminalHistoryEnv('/bin/bash', undefined), {})
    assert.deepEqual(terminalHistoryEnv('/bin/bash', null), {})
  })

  it('honours the "share command history" setting turned off', async () => {
    await setSetting(SHARE_TERMINAL_HISTORY_ENABLED_SETTING, false)
    try {
      assert.deepEqual(terminalHistoryEnv('/bin/bash', 'project-off'), {})
    } finally {
      await setSetting(
        SHARE_TERMINAL_HISTORY_ENABLED_SETTING,
        SHARE_TERMINAL_HISTORY_ENABLED_DEFAULT,
      )
    }
  })

  it("recalls a command typed in one thread from a second thread's terminal (real PTYs)", async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX shell / readline assertion')
      return
    }
    let spawnOk = true
    const probe = mockWindow(OWNER)
    try {
      const probeId = await createTerminalSession(probe, 80, 24, { projectId: 'probe' })
      destroyTerminalSession(probeId, OWNER)
    } catch {
      spawnOk = false
    }
    if (!spawnOk) {
      t.skip('PTY spawn unavailable in this environment')
      return
    }

    const projectId = 'project-live-history'
    const marker = `copse_history_marker_${Date.now().toString()}`
    const win1 = mockWindow(OWNER)
    const win2 = mockWindow(OTHER_OWNER)
    let session1 = ''
    let session2 = ''
    try {
      // Thread 1's terminal: type one command line, then flush bash's
      // in-memory history to the shared HISTFILE. `history -a` is an ordinary
      // command typed into the terminal — not a PROMPT_COMMAND/rc-file
      // override — and joining it onto the same line keeps this the single
      // history entry thread 2 should see, with no ambiguity about which
      // history slot the up arrow lands on.
      const historyLine = `echo ${marker}; history -a`
      session1 = await createTerminalSession(win1, 80, 24, {
        threadId: 'thread-1',
        projectId,
      })
      writeTerminalSession(session1, OWNER, `${historyLine}\n`)
      await waitForTerminalOutput(win1, new RegExp(marker))
      // `history -a`'s own completion produces no terminal output to poll
      // for (unlike the echoed marker above), so there is no event to wait
      // on before it has actually written the shared HISTFILE — a short
      // fixed pause is the only option here.
      await new Promise((resolve) => setTimeout(resolve, 500))
      destroyTerminalSession(session1, OWNER)

      // Thread 2's terminal: a fresh shell for the same project. It never
      // types a command of its own before pressing the up arrow, so the one
      // history entry loaded from the shared file is unambiguously what a
      // single up arrow (readline's previous-history binding) recalls.
      session2 = await createTerminalSession(win2, 80, 24, {
        threadId: 'thread-2',
        projectId,
      })
      // Wait for the shell's first output (its startup prompt) before sending
      // the arrow key — sending it before then races the shell into raw
      // (readline) terminal mode and just echoes the raw escape bytes instead
      // of recalling history (the same startup race the CWD test above guards
      // against with its own marker).
      await waitForTerminalOutput(win2, /[\s\S]/)
      writeTerminalSession(session2, OTHER_OWNER, '\x1b[A')
      const recalled = await waitForTerminalOutput(win2, new RegExp(marker))
      assert.match(
        recalled,
        new RegExp(historyLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'up-arrow in the second thread recalls the command typed in the first',
      )
    } finally {
      if (session1) destroyTerminalSession(session1, OWNER)
      if (session2) destroyTerminalSession(session2, OTHER_OWNER)
    }
  })
})
