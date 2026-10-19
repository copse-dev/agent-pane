import { createStore } from '@shared/store/store.ts'
import type { StreamChunk } from '@shared/types/stream.ts'
import type { ApiClient } from '../../../src/preload/api.d.ts'
import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import { startAgentController } from '../../../src/renderer/controller/agent.ts'
import { mountConversation } from '../../../src/renderer/views/conversation.ts'
import { mountTerminalsPane } from '../../../src/renderer/views/terminals-pane.ts'

/**
 * First turn of an ACP agent on an SSH project, with the Shells pane open:
 * the agent controller receives a remote setup stage, and Copse adds a shell
 * for the newly started thread on its own. The spec reads the counters below.
 */
declare global {
  interface Window {
    remoteFirstRun: {
      terminalCreates: number
      sendChunk: (chunk: StreamChunk) => void
      startThread: (id: string) => void
    }
  }
}

const conversation = document.querySelector<HTMLElement>('#conversation')
const shells = document.querySelector<HTMLElement>('#shells')
const viewer = document.querySelector<HTMLElement>('#viewer')
if (!conversation || !shells || !viewer) throw new Error('Missing fixture mount')

const store = createStore({
  workspaceRoot: '/srv/app',
  projects: [{ id: 'remote', name: 'Dev:/srv/app', path: '/srv/app', sshHost: 'dev' }],
  activeProjectId: 'remote',
  activeThreadId: 'thread-1',
  filesPaneOpen: true,
  rightPanelMode: 'terminal',
  threads: [
    {
      id: 'thread-1',
      title: 'Explain the build',
      status: 'running',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'How is this project built?',
          toolCalls: [],
          createdAt: 1,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    },
  ],
})

let chunkHandler: ((threadId: string, chunk: StreamChunk) => void) | null = null
const base = createFakeApi()
const state = { terminalCreates: 0 }
const api: ApiClient = {
  ...base,
  agent: {
    ...base.agent,
    onChunk: (handler) => {
      chunkHandler = handler
      return (): void => {}
    },
  },
  terminal: {
    ...base.terminal,
    create: (...args) => {
      state.terminalCreates += 1
      return base.terminal.create(...args)
    },
  },
}

startAgentController(store, api)
mountConversation(conversation, store, api)
mountTerminalsPane(shells, viewer, store, api)

window.remoteFirstRun = {
  get terminalCreates(): number {
    return state.terminalCreates
  },
  sendChunk: (chunk) => {
    chunkHandler?.('thread-1', chunk)
  },
  startThread: (id) => {
    const { threads } = store.getState()
    store.setState({
      threads: [
        ...threads,
        {
          id,
          title: 'New thread',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      activeThreadId: id,
    })
    store.emit('threads_changed')
  },
}
