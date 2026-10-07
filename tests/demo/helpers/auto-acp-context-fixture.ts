import { createStore } from '@shared/store/store.ts'
import { updateContextSnapshot } from '@shared/store/thread-helpers.ts'
import type { ContextBreakdown } from '@shared/types'
import { commitThreadModelSelection } from '../../../src/renderer/controller/model-selection.ts'
import { createFakeApi } from '../../../src/renderer/fake-api.test-support.ts'
import { mountInputBar } from '../../../src/renderer/views/input-bar.ts'

// Inject only the preload boundary; the input bar, model selection and context
// updates are the same functions used by the renderer's agent controller.
const app = document.querySelector<HTMLElement>('#app')
if (!app) throw new Error('Missing fixture mount')
const controls = document.querySelector<HTMLElement>('#fixture-controls')
if (!controls) throw new Error('Missing fixture controls')
const late = new URLSearchParams(location.search).get('mode') === 'late'
const pending = Promise.withResolvers<ContextBreakdown>()
const breakdown: ContextBreakdown = {
  segments: [{ key: 'system', label: 'System prompt', tokens: 30_000 }],
  totalTokens: 30_000,
  contextWindow: 200_000,
}
const store = createStore({
  workspaceRoot: '/workspace',
  projects: [{ id: 'project-1', name: 'Copse', path: '/workspace' }],
  activeProjectId: 'project-1',
  activeThreadId: 'thread-1',
  threads: [
    {
      id: 'thread-1',
      title: 'Review the renderer',
      status: 'idle',
      model: 'auto:balanced',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    },
  ],
})
const api = createFakeApi()
let estimates = 0
api.agent.estimateContext = async (): Promise<ContextBreakdown> => {
  controls.dataset['estimates'] = String(++estimates)
  return late ? pending.promise : breakdown
}
api.settings.get = async (key): Promise<unknown> =>
  key === 'registeredAcpAgents'
    ? [
        {
          id: 'claude-acp',
          title: 'Claude Code',
          command: 'claude-agent-acp',
          enabled: true,
          availableModels: [{ value: 'opus', label: 'Claude Opus 5.5' }],
        },
      ]
    : undefined
app.style.cssText =
  'width:640px;height:480px;padding:24px;display:flex;flex-direction:column;box-sizing:border-box;background:var(--bg)'
const message = document.createElement('div')
message.textContent = 'Review the context estimate when the model changes.'
message.style.cssText = 'flex:1;color:var(--text)'
app.append(message)
const input = document.createElement('div')
app.append(input)
mountInputBar(input, store, api)

const control = (id: string, label: string, action: () => void): void => {
  const button = document.createElement('button')
  button.id = id
  button.textContent = label
  button.addEventListener('click', action)
  controls.append(button)
}
control('resolve-acp', 'Resolve Auto to ACP', () => {
  commitThreadModelSelection(store, api, 'thread-1', 'auto', 'auto:balanced', 'acp:claude-acp#opus')
})
control('finish-estimate', 'Return the old native estimate', () => {
  pending.resolve(breakdown)
})
control('report-usage', 'Report ACP usage', () => {
  updateContextSnapshot(store, 'thread-1', {
    contextWindow: 200_000,
    conversationBudget: 200_000,
    conversationTokens: 80_000,
    fillRatio: 0.4,
    source: 'agent-reported',
  })
})
