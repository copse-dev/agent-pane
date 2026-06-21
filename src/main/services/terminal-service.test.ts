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

function mockWindow() {
  const sent: Array<[string, ...unknown[]]> = []
  return {
    webContents: {
      send(channel: string, ...args: unknown[]) {
        sent.push([channel, ...args])
      },
    },
    sent,
  } as unknown as import('electron').BrowserWindow & { sent: typeof sent }
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
