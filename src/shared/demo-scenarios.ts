import type { Project, Thread } from './types/index.ts'

const FIXED_TIME = Date.UTC(2026, 6, 17, 9, 0, 0)
const FOOTER_INPUT_TOKENS = 50_000
const FOOTER_OUTPUT_TOKENS = 1_800

export interface DemoScenario {
  id: string
  label: string
  project: Project
  threads: Thread[]
  settings: Readonly<Record<string, unknown>>
}

export const FOOTER_COMPACT_EXPECTATIONS = {
  tokenLabel: `${((FOOTER_INPUT_TOKENS + FOOTER_OUTPUT_TOKENS) / 1000).toFixed(1)}k tokens`,
} as const

const markdownContent = [
  '### ⚠️ Known Failures',
  '',
  '**Unit tests (2 failures):**',
  '- `terminal-service` — 2 subtests fail with posix spawnp failed',
  '',
  '**E2E tests (all 10 fail):**',
  '- Every e2e test fails with listen EPERM: operation not permitted 0.0.0.0',
  '',
  '### 📦 Architecture Highlights',
  '- Electron app — AI coding assistant with tool-executing agents',
  '- No backend — Direct LLM provider calls (Anthropic, OpenAI, LM Studio)',
  '- Mock LLM — `COPSE-PANEL-MOCK-LLM=1` enables full e2e testing without API keys',
  '- MCP host — Per-server enable toggles in Settings',
  '- Persistence — filesystem-native threads and project settings',
].join('\n')

const project = (id: string): Project => ({ id, path: '/demo/copse', name: 'copse-demo' })

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'markdown-list-indent',
    label: 'Markdown list indentation',
    project: project('demo-markdown-project'),
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
    project: project('demo-footer-project'),
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
        usage: { inputTokens: FOOTER_INPUT_TOKENS, outputTokens: FOOTER_OUTPUT_TOKENS },
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
