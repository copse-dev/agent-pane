import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSession,
  resizeTerminalSession,
  writeTerminalSession,
} from './terminal-service.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

const OWNER = 1
const OTHER_OWNER = 2

function mockWindow(): import('electron').BrowserWindow & {
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
  return win as unknown as import('electron').BrowserWindow & {
    sent: typeof sent
    markDestroyed: () => void
  }
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
      assert.throws(() => writeTerminalSession(sessionId, OWNER, 'x'), /Unknown terminal session/)
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
      assert.throws(
        () => writeTerminalSession(sessionId, OTHER_OWNER, 'x'),
        /not owned by the caller/,
      )
      assert.throws(
        () => resizeTerminalSession(sessionId, OTHER_OWNER, 80, 24),
        /not owned by the caller/,
      )
      assert.throws(() => destroyTerminalSession(sessionId, OTHER_OWNER), /not owned by the caller/)
      // The owner can still operate on its own session.
      writeTerminalSession(sessionId, OWNER, 'x')
    } finally {
      if (sessionId) destroyTerminalSession(sessionId, OWNER)
      restore()
    }
  })
})
