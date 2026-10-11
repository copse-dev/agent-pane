import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import { mountConversation } from '../../../src/renderer/views/conversation.ts'
import { mountInputBar } from '../../../src/renderer/views/input-bar.ts'

const conversation = document.querySelector<HTMLElement>('#conversation')
const input = document.querySelector<HTMLElement>('#input')
if (!conversation || !input) throw new Error('Missing fixture mount')
const store = createStore({
  workspaceRoot: '/workspace',
  projects: [{ id: 'project-1', name: 'Copse', path: '/workspace' }],
  activeProjectId: 'project-1',
  activeThreadId: 'thread-1',
  threads: [
    {
      id: 'thread-1',
      title: 'Review memory use',
      status: 'running',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Investigate the memory used by background tasks.',
          toolCalls: [],
          createdAt: 1,
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content:
            'Waiting for an available agent slot. You can stop this turn while it is queued.\n\n',
          toolCalls: [],
          createdAt: 2,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 2,
    },
  ],
})
const api = createFakeApi()
mountConversation(conversation, store, api)
mountInputBar(input, store, api)
