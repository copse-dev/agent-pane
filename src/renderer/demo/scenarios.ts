import type { Project, Thread } from '@shared/types'

const FIXED_TIME = Date.UTC(2026, 6, 17, 9, 0, 0)

export interface DemoScenario {
  id: string
  label: string
  project: Project
  threads: Thread[]
  settings: Readonly<Record<string, unknown>>
}

const markdownContent = [
  '### Known Failures',
  '',
  '**Unit tests (2 failures):**',
  '- `terminal-service` — 2 subtests fail with posix spawnp failed',
  '',
  '**E2E tests (all 10 fail):**',
  '- Every e2e test fails with listen EPERM: operation not permitted 0.0.0.0',
  '',
  '### Architecture Highlights',
  '- Electron app — AI coding assistant with tool-executing agents',
  '- No backend — direct LLM provider calls',
  '- Mock LLM — deterministic conversations without API keys',
  '- MCP host — per-server enable toggles in Settings',
  '- Persistence — filesystem-native threads and project settings',
].join('\n')

const markdownProject: Project = {
  id: 'demo-markdown-project',
  path: '/demo/copse',
  name: 'copse-demo',
}

const footerProject: Project = {
  id: 'demo-footer-project',
  path: '/demo/copse',
  name: 'copse-demo',
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'markdown-list-indent',
    label: 'Markdown list indentation',
    project: markdownProject,
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-markdown-thread',
        title: 'Markdown list indentation',
        status: 'idle',
        messages: [
          {
            id: 'demo-markdown-assistant',
            role: 'assistant',
            content: markdownContent,
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'footer-compact',
    label: 'Responsive composer footer',
    project: footerProject,
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model: 'lmstudio:qwen/qwen3.6-35b-a3b',
    },
    threads: [
      {
        id: 'demo-footer-thread',
        title: 'Footer compact layout',
        status: 'idle',
        gitBranch: 'demo/responsive-footer-layout',
        messages: [
          {
            id: 'demo-footer-user',
            role: 'user',
            content: 'Check footer layout at narrow widths.',
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
        ],
        usage: { inputTokens: 50_000, outputTokens: 1_800 },
        contextSnapshot: {
          contextWindow: 200_000,
          conversationBudget: 180_000,
          conversationTokens: 9_000,
          fillRatio: 0.05,
          updatedAt: FIXED_TIME,
        },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
]

export function selectDemoScenario(search: string): DemoScenario {
  const requested = new URLSearchParams(search).get('scenario')
  const selected = DEMO_SCENARIOS.find((scenario) => scenario.id === requested)
  if (selected) return selected
  const fallback = DEMO_SCENARIOS[0]
  if (!fallback) throw new Error('At least one browser demo scenario is required.')
  return fallback
}
