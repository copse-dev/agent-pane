import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import { mountConversation } from '../../../src/renderer/views/conversation.ts'

// Mounts the real conversation over an in-memory store with one long-running
// shell card and one finished edit card. The spec drives tool-status churn and
// new tool calls through `window.toolDisclosureFixture` the way agent events
// would.

declare global {
  interface Window {
    toolDisclosureFixture: {
      setShellStatus(status: 'running' | 'done'): void
      addRead(id: string, path: string): void
    }
  }
}

const conversation = document.querySelector<HTMLElement>('#conversation')
if (!conversation) throw new Error('Missing fixture mount')
const store = createStore({ workspaceRoot: '/workspace' })
const threadId = createThread(store)
addMessage(store, threadId, 'user', 'Run the tests and update the notes.')
const messageId = addMessage(store, threadId, 'assistant', '')
mountConversation(conversation, store, createFakeApi())
addToolCall(store, messageId, {
  id: 'tc-shell',
  name: 'run_shell',
  args: { command: 'pnpm test' },
  status: 'running',
  result: null,
})
addToolCall(store, messageId, {
  id: 'tc-edit',
  name: 'write_file',
  args: { path: 'notes.md', content: '# Notes\n\nTests pass.\n' },
  status: 'done',
  result: 'Wrote notes.md',
})

window.toolDisclosureFixture = {
  setShellStatus(status): void {
    updateToolCall(store, messageId, 'tc-shell', {
      status,
      result: status === 'done' ? 'All tests passed.' : null,
    })
  },
  addRead(id, path): void {
    addToolCall(store, messageId, {
      id,
      name: 'read_file',
      args: { path },
      status: 'done',
      result: `Contents of ${path}`,
    })
  },
}
