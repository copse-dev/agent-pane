import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTerminalSession,
  destroyAllTerminalSessions,
  destroyTerminalSession,
  writeTerminalSession,
} from './terminal-service.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

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

describe('terminal-service', () => {
  afterEach(() => {
    destroyAllTerminalSessions()
  })

  it('creates a session and streams output', async () => {
    const restore = setWorkspaceRootForTest('/tmp')
    const win = mockWindow()
    let sessionId = ''
    try {
      sessionId = await createTerminalSession(win)
      assert.ok(sessionId)
      writeTerminalSession(sessionId, 'echo hello\n')
      await new Promise((r) => setTimeout(r, 300))
      const outputEvents = win.sent.filter(([ch]) => ch === 'terminal:output')
      assert.ok(outputEvents.length > 0)
      const combined = outputEvents.map(([, , data]) => data).join('')
      assert.match(combined, /hello/)
    } finally {
      if (sessionId) destroyTerminalSession(sessionId)
      restore()
    }
  })

  it('destroys a session', async () => {
    const restore = setWorkspaceRootForTest('/tmp')
    const win = mockWindow()
    let sessionId = ''
    try {
      sessionId = await createTerminalSession(win)
      destroyTerminalSession(sessionId)
      assert.throws(() => writeTerminalSession(sessionId, 'x'), /Unknown terminal session/)
    } finally {
      restore()
    }
  })
})
