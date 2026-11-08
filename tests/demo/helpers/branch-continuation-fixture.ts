import type { DemoScenario } from '@shared/demo-scenarios.ts'
import type { ApiClient } from '../../../src/preload/api.d.ts'
import { useAnnouncementCatalog } from '../../../src/renderer/announcement-catalog.ts'
import { createDemoApi } from '../../../src/renderer/demo/demo-api.ts'

// Hold only the existing preload request. Navigation, draft restoration,
// warning actions and submission run through the unchanged real renderer.
const otherWarning = new URLSearchParams(location.search).has('other-warning')
const createdAt = Date.UTC(2026, 6, 17, 9, 0, 0)
const scenario: DemoScenario = {
  id: 'branch-continuation',
  label: 'Pending branch confirmation',
  project: { id: 'branch-project', name: 'Copse', path: '/workspace' },
  threads: [
    {
      id: 'branch-first',
      title: 'Review the first change',
      status: 'idle',
      gitBranch: 'feature/first',
      worktreeChoice: 'shared',
      messages: [
        {
          id: 'first-request',
          role: 'user',
          content: 'Review the first change.',
          toolCalls: [],
          createdAt,
        },
        {
          id: 'first-answer',
          role: 'assistant',
          content: 'The first change is ready for a follow-up.',
          toolCalls: [],
          createdAt,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: 'branch-second',
      title: 'Keep this draft unsent',
      status: 'idle',
      gitBranch: otherWarning ? 'feature/second' : 'main',
      worktreeChoice: 'shared',
      messages: [
        {
          id: 'second-request',
          role: 'user',
          content: 'Keep these review notes in this chat.',
          toolCalls: [],
          createdAt,
        },
        {
          id: 'second-answer',
          role: 'assistant',
          content: 'The notes are saved for your next message.',
          toolCalls: [],
          createdAt,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt,
      updatedAt: createdAt,
    },
  ],
  settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
}
const pending = Promise.withResolvers<{ currentBranch: string; pr: null }>()
const api = createDemoApi(scenario)
api.git.currentBranch = (): ReturnType<ApiClient['git']['currentBranch']> => Promise.resolve('main')
api.git.branchStatus = (
  _projectId,
  _threadId,
  forBranch,
): ReturnType<ApiClient['git']['branchStatus']> => {
  if (forBranch !== undefined) return Promise.resolve({ currentBranch: 'main', pr: null })
  document.body.dataset['branchLookup'] = 'held'
  return pending.promise
}
let runs = 0
document.body.dataset['agentRuns'] = '0'
api.agent.run = async (): Promise<void> => {
  document.body.dataset['agentRuns'] = String(++runs)
}
useAnnouncementCatalog([])
window.api = api
document.documentElement.dataset['demoScenario'] = scenario.id
void import('../../../src/renderer/main.ts').then(async (main) => {
  await main.rendererReady
  // This boundary control disappears when used, before the real app capture.
  const finish = document.createElement('button')
  finish.id = 'finish-branch-lookup'
  finish.textContent = 'Return the pending branch response'
  finish.style.cssText = 'position:fixed;right:16px;top:16px;z-index:10000'
  finish.addEventListener('click', () => {
    pending.resolve({ currentBranch: 'main', pr: null })
    document.body.dataset['branchLookup'] = 'returned'
    finish.remove()
  })
  document.body.append(finish)
})
