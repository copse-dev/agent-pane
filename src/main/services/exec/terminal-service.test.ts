import { describe, it, afterEach, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

async function waitForFileContents(
  path: string,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const contents = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (pattern.test(contents)) return contents
    if (Date.now() >= deadline) return contents
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForTerminalExit(
  win: ReturnType<typeof mockWindow>,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (win.sent.some(([channel, id]) => channel === 'terminal:exit' && id === sessionId)) {
      return true
    }
    if (Date.now() >= deadline) return false
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

  it('leaves fish untouched because its named histories live outside COPSE_DIR', () => {
    const env = terminalHistoryEnv('/usr/bin/fish', 'project-fish')
    assert.deepEqual(env, {})
  })

  it('sets PROMPT_COMMAND for bash so a running shell flushes to and reloads from the shared HISTFILE', () => {
    const env = terminalHistoryEnv('/bin/bash', 'project-bash-prompt', {})
    assert.equal(env['PROMPT_COMMAND'], 'shopt -s histappend; history -n; history -w')
  })

  it('prepends onto an existing PROMPT_COMMAND instead of replacing it', () => {
    const env = terminalHistoryEnv('/bin/bash', 'project-bash-prompt-existing', {
      PROMPT_COMMAND: 'my_custom_hook',
    })
    assert.equal(
      env['PROMPT_COMMAND'],
      'shopt -s histappend; history -n; history -w; my_custom_hook',
    )
  })

  it('does not set PROMPT_COMMAND for zsh or fish', () => {
    const zshEnv = terminalHistoryEnv('/usr/bin/zsh', 'project-zsh-prompt')
    assert.equal(zshEnv['PROMPT_COMMAND'], undefined)
    const fishEnv = terminalHistoryEnv('/usr/bin/fish', 'project-fish-prompt')
    assert.equal(fishEnv['PROMPT_COMMAND'], undefined)
  })

  it('leaves agent/tool shells (no projectId) untouched', () => {
    assert.deepEqual(terminalHistoryEnv('/bin/bash', undefined), {})
    assert.deepEqual(terminalHistoryEnv('/bin/bash', null), {})
  })

  it('honours the "share command history" setting turned off, including PROMPT_COMMAND', async () => {
    await setSetting(SHARE_TERMINAL_HISTORY_ENABLED_SETTING, false)
    try {
      const env = terminalHistoryEnv('/bin/bash', 'project-off', { PROMPT_COMMAND: 'my_hook' })
      assert.deepEqual(env, {})
      assert.equal(env['PROMPT_COMMAND'], undefined)
    } finally {
      await setSetting(
        SHARE_TERMINAL_HISTORY_ENABLED_SETTING,
        SHARE_TERMINAL_HISTORY_ENABLED_DEFAULT,
      )
    }
  })

  it("recalls a command typed in one thread's still-open terminal from a second thread's terminal (real PTYs)", async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX shell / readline assertion')
      return
    }
    // Use the repository's no-rc Bash fixture instead of the developer or CI
    // host's login shell. Otherwise a ~/.zshrc or ~/.bashrc can replace
    // HISTFILE/PROMPT_COMMAND and the test reads real user history rather than
    // exercising terminalHistoryEnv at all.
    const previousShell = process.env['SHELL']
    process.env['SHELL'] = join(process.cwd(), 'tests/e2e/fixtures/e2e-bash-shell.sh')
    let spawnOk = true
    const probe = mockWindow(OWNER)
    try {
      const probeId = await createTerminalSession(probe, 80, 24, { projectId: 'probe' })
      destroyTerminalSession(probeId, OWNER)
    } catch {
      spawnOk = false
    }
    if (!spawnOk) {
      if (previousShell === undefined) delete process.env['SHELL']
      else process.env['SHELL'] = previousShell
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
      // Thread 1's terminal: type one plain command line — no `history -a`,
      // no rc-file hook. `terminalHistoryEnv`'s `PROMPT_COMMAND` is what
      // flushes it: bash runs `history -a; history -n` on its own as it
      // returns to its prompt after the command finishes, appending this
      // shell's new line to the shared HISTFILE. Deliberately left running
      // (not destroyed) so the recall below proves *live* sharing between two
      // still-open shells, not just a HISTFILE a later shell happens to load.
      const command = `echo ${marker}`
      session1 = await createTerminalSession(win1, 80, 24, {
        threadId: 'thread-1',
        projectId,
      })
      writeTerminalSession(session1, OWNER, `${command}\n`)
      const firstOutput = await waitForTerminalOutput(win1, new RegExp(marker))
      // `PROMPT_COMMAND` firing produces no terminal output of its own, so
      // synchronize on the actual persistence contract instead of a timing
      // guess: the marker must land in the shared HISTFILE before shell 2 is
      // allowed to start and load it.
      const historyPath = join(projectStoreDir(projectId), TERMINAL_HISTORY_FILENAME)
      const history = await waitForFileContents(historyPath, new RegExp(marker))
      assert.match(
        history,
        new RegExp(marker),
        `the first shell flushes its command to HISTFILE; shell output:\n${firstOutput}`,
      )

      // Thread 2's terminal: a fresh shell for the same project, opened while
      // thread 1's shell above is still running. It never types a command of
      // its own before pressing the up arrow, so the one history entry loaded
      // from the shared file is unambiguously what a single up arrow
      // (readline's previous-history binding) recalls.
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
        new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'up-arrow in the second thread recalls the command typed in the still-open first thread',
      )

      // A stale shell must not erase a newer command from another shell when
      // it exits. Cancel the recalled line, run a distinct command in shell 2,
      // wait for its prompt-time flush, then exit shell 1 without giving it a
      // chance to import shell 2's command first. `histappend` is what makes
      // that exit append shell 1's own entries instead of overwriting the
      // shared file with its stale in-memory list.
      const secondMarker = `${marker}_second`
      writeTerminalSession(session2, OTHER_OWNER, '\x03')
      await new Promise((resolve) => setTimeout(resolve, 50))
      writeTerminalSession(session2, OTHER_OWNER, `echo ${secondMarker}\n`)
      await waitForTerminalOutput(win2, new RegExp(secondMarker))
      const historyWithSecond = await waitForFileContents(historyPath, new RegExp(secondMarker))
      assert.match(historyWithSecond, new RegExp(secondMarker))

      writeTerminalSession(session1, OWNER, 'exit\n')
      assert.equal(await waitForTerminalExit(win1, session1), true, 'first shell exits cleanly')
      session1 = ''
      const historyAfterStaleExit = readFileSync(historyPath, 'utf8')
      assert.match(
        historyAfterStaleExit,
        new RegExp(secondMarker),
        'a stale shell exit must not overwrite a newer command from another shell',
      )
    } finally {
      if (previousShell === undefined) delete process.env['SHELL']
      else process.env['SHELL'] = previousShell
      if (session1) destroyTerminalSession(session1, OWNER)
      if (session2) destroyTerminalSession(session2, OTHER_OWNER)
    }
  })
})
