import { createStore } from '@shared/store/store.ts'
import { addMessage, addToolCall, createThread } from '@shared/store/thread-helpers.ts'
import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import { mountConversation } from '../../../src/renderer/views/conversation.ts'

// Mounts the real conversation over an in-memory store. A long-running shell
// card renders on its own (scheduling its delayed reveal), then a finished edit
// arrives in the same tick and absorbs it into the activity rollup before that
// delay elapses. The absorbed card is background activity and must stay closed.

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
