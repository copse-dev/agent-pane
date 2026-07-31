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

const semanticSearchSummary = [
  'Here is the complete summary of how semantic search is classified, routed, and executed:',
  '',
  '---',
  '',
  "## Search Routing Summary ('search-routing.ts')",
  '',
  "### 1. Classification ('classifySearchQuery')",
  '',
  '**File:** `src/main/services/search-routing.ts`',
  '',
  'The router picks semantic vs grep based on query shape.',
  '',
  '- **Semantic path** — embedding search via `search_codebase`',
  '- **Grep path** — ripgrep via `grep_search`',
  '',
  '### 2. Execution',
  '',
  'Let me find where this classification function is called.',
  '',
  '- Read `search-routing.ts`',
  '- Search for `classifySearchQuery`',
].join('\n')

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
      // Copy/export overflow actions are developer-mode gated; the geometry
      // demo needs them visible to exercise `.footer-overflow`.
      developerMode: true,
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
  {
    id: 'subagent-display',
    label: 'Subagent display visual reference',
    project: project('demo-subagent-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-subagent-thread',
        title: 'Subagent display test',
        status: 'idle',
        messages: [
          {
            id: 'demo-subagent-assistant',
            role: 'assistant',
            content: 'Here is what the subagent found.',
            toolCalls: [
              {
                id: 'demo-explore-call',
                name: 'explore',
                args: { query: 'Find README' },
                status: 'done',
                result: 'README describes Copse setup and dev workflow.',
                subagent: {
                  id: 'demo-explore-session',
                  kind: 'explore',
                  status: 'done',
                  prompt: 'Find README',
                  summary: 'README describes Copse setup and dev workflow.',
                  messages: [
                    {
                      id: 'demo-explore-message-1',
                      role: 'assistant',
                      content: 'Reading **README.md** for project overview.',
                      toolCalls: [
                        {
                          id: 'demo-inner-read',
                          name: 'read_file',
                          args: { path: 'README.md' },
                          status: 'done',
                          result: '# Copse\n',
                        },
                      ],
                    },
                    {
                      id: 'demo-explore-message-2',
                      role: 'assistant',
                      content: 'README describes Copse setup and dev workflow.',
                      toolCalls: [],
                    },
                  ],
                },
              },
            ],
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
    // #728: a subagent-backed explore must stay its own card when a sibling
    // read_file would otherwise fold both into a "Read files" group.
    id: 'subagent-ungrouped',
    label: 'Subagent stays ungrouped beside reading tools',
    project: project('demo-subagent-ungrouped-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-subagent-ungrouped-thread',
        title: 'Subagent ungrouped',
        status: 'idle',
        messages: [
          {
            id: 'demo-subagent-ungrouped-assistant',
            role: 'assistant',
            content: 'Explored the repo and read the README.',
            toolCalls: [
              {
                id: 'demo-ungrouped-explore',
                name: 'explore',
                args: { query: 'Find README' },
                status: 'done',
                result: 'README describes Copse setup.',
                subagent: {
                  id: 'demo-ungrouped-session',
                  kind: 'explore',
                  status: 'done',
                  prompt: 'Find README',
                  summary: 'README describes Copse setup.',
                  messages: [
                    {
                      id: 'demo-ungrouped-msg',
                      role: 'assistant',
                      content: 'Found **README.md**.',
                      toolCalls: [],
                    },
                  ],
                },
              },
              {
                id: 'demo-ungrouped-read',
                name: 'read_file',
                args: { path: 'README.md' },
                status: 'done',
                result: '# Copse\n',
              },
            ],
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
    id: 'semantic-search-markdown',
    label: 'Semantic search subagent markdown',
    project: project('demo-semantic-search-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-semantic-search-thread',
        title: 'Mechanism Explained',
        status: 'idle',
        messages: [
          {
            id: 'demo-semantic-user',
            role: 'user',
            content: 'is there semantic search',
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
          {
            id: 'demo-semantic-assistant',
            role: 'assistant',
            content:
              "Good find — there *is* semantic search in the agent's code search routing. Let me explore it.",
            toolCalls: [
              {
                id: 'demo-semantic-explore',
                name: 'explore',
                args: { query: 'How is semantic search routed?' },
                status: 'done',
                result: semanticSearchSummary,
                subagent: {
                  id: 'demo-semantic-session',
                  kind: 'explore',
                  status: 'done',
                  prompt: 'How is semantic search routed?',
                  summary: semanticSearchSummary,
                  messages: [
                    {
                      id: 'demo-semantic-summary',
                      role: 'assistant',
                      content: semanticSearchSummary,
                      toolCalls: [],
                    },
                  ],
                },
              },
            ],
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
    id: 'settings-footer',
    label: 'Settings scroll + sticky footer geometry',
    project: project('demo-settings-footer-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-settings-footer-thread',
        title: 'Settings footer',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'chat-layout-styling',
    label: 'Chat layout styling',
    project: project('demo-chat-layout-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-chat-layout-thread',
        title: 'Chat layout styling',
        status: 'idle',
        messages: [
          {
            id: 'demo-chat-layout-user',
            role: 'user',
            content: 'Check the pane dividers and conversation gradient.',
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
          {
            id: 'demo-chat-layout-assistant',
            role: 'assistant',
            content: 'The deterministic browser fixture is ready for layout measurement.',
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
]
