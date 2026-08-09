import type { Project, Thread } from './types/index.ts'
import type { DemoTrace } from './demo-traces.ts'
import { LANDING_TRACE } from './demo-traces/landing.ts'

const FIXED_TIME = Date.UTC(2026, 6, 17, 9, 0, 0)
const FOOTER_INPUT_TOKENS = 50_000
const FOOTER_OUTPUT_TOKENS = 1_800

export interface DemoScenario {
  id: string
  label: string
  project: Project
  threads: Thread[]
  settings: Readonly<Record<string, unknown>>
  /**
   * A recorded turn the demo can replay when its prompt is submitted. Scenarios
   * without one are static fixtures for visual tests; a scenario with one is a
   * walkthrough — the composer types the prompt and the answer streams back
   * through the ordinary chunk path.
   */
  trace?: DemoTrace
  /**
   * A shorter prompt to type in the walkthrough while preserving the trace's
   * exact recorded prompt as steering. This is intentionally explicit: the
   * demo must not imply that a terse request produced a tightly art-directed
   * recording without help.
   */
  presentedPrompt?: {
    text: string
    /** How the recorded prompt supplements the visitor-visible request. */
    tracePromptRole: 'nudge'
    /** Human-readable provenance for reviewers inspecting the scenario. */
    nudgeLabel: string
  }
  /**
   * Queue replayed edits without forcing Changes open on every write. Visitors
   * can still open Changes and inspect the complete diffs after the turn.
   */
  deferProposedDiffPreview?: boolean
  /**
   * Published directory containing the files produced by the trace. The static
   * Browser panel prefers this checked-in copy, while the replayed writes still
   * drive Changes and provide a fallback for older builds.
   */
  staticSite?: string
  /**
   * After a walkthrough finishes, follow its final browser link and expand the
   * loaded preview in place. This is the static demo equivalent of a visitor
   * clicking the URL and then the pane's Expand control.
   */
  revealFinalPreview?: boolean
}

export const FOOTER_COMPACT_EXPECTATIONS = {
  tokenLabel: `${((FOOTER_INPUT_TOKENS + FOOTER_OUTPUT_TOKENS) / 1000).toFixed(1)}k tokens`,
} as const

/** Prompt a walkthrough submits; the source trace remains byte-for-byte honest. */
export function demoScenarioPrompt(scenario: DemoScenario): string {
  return scenario.presentedPrompt?.text ?? scenario.trace?.prompt ?? ''
}

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

const project = (id: string, name = 'copse-demo', path = '/demo/copse'): Project => ({
  id,
  path,
  name,
})

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

const PROPOSED_INDEX_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <title>Sample</title>',
  '    <link rel="stylesheet" href="styles.css" />',
  '  </head>',
  '  <body>',
  '    <h1>Hello</h1>',
  '  </body>',
  '</html>',
  '',
].join('\n')

const PROPOSED_STYLES_CSS = ['h1 {', '  font-family: system-ui, sans-serif;', '}', ''].join('\n')

/**
 * A turn that writes two new files. Hand-written: its job is to put the Changes
 * panel into its proposed-diff state for visual review, not to reproduce a run.
 */
const PROPOSED_DIFF_TRACE: DemoTrace = {
  id: 'proposed-diff',
  label: 'Proposed edits',
  prompt: 'add a starter page and stylesheet',
  steps: [
    {
      chunk: {
        type: 'text',
        text: 'Adding a minimal page and the stylesheet it links to.',
      },
    },
    {
      chunk: {
        type: 'tool_call',
        toolCall: {
          id: 'tc-1',
          name: 'write_file',
          args: { path: 'index.html', content: PROPOSED_INDEX_HTML },
        },
      },
      delayMs: 700,
    },
    {
      chunk: {
        type: 'tool_result',
        toolCallId: 'tc-1',
        result: 'Proposed index.html (+12)',
        isError: false,
      },
      delayMs: 900,
    },
    {
      chunk: {
        type: 'tool_call',
        toolCall: {
          id: 'tc-2',
          name: 'write_file',
          args: { path: 'styles.css', content: PROPOSED_STYLES_CSS },
        },
      },
      delayMs: 700,
    },
    {
      chunk: {
        type: 'tool_result',
        toolCallId: 'tc-2',
        result: 'Proposed styles.css (+4)',
        isError: false,
      },
      delayMs: 900,
    },
    {
      chunk: {
        type: 'text',
        text: 'Both files are staged in **Changes** — review the diffs and accept or reject each one.',
      },
    },
    { chunk: { type: 'done', stopReason: 'end_turn' }, delayMs: 300 },
  ],
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    // First, so a bare `/demo/<branch>/` opens on the walkthrough rather than a
    // visual-test fixture. It is also what the marketing hero iframe embeds.
    id: 'landing',
    label: 'Builds a cupcake site',
    project: project('demo-landing-project', 'Crumb & Bloom', '/demo/crumb-and-bloom'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model: LANDING_TRACE.source?.model ?? 'claude-opus-5',
      layout: {
        projectsPaneWidth: 240,
        filesPaneWidth: 640,
        filesPaneHeight: 360,
        fileTreeWidth: 140,
      },
    },
    threads: [
      {
        // Empty on purpose: the walkthrough types the prompt into the composer,
        // so the transcript builds from nothing while you watch.
        id: 'demo-landing-thread',
        title: 'Crumb & Bloom coming soon',
        status: 'idle',
        gitBranch: 'main',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    trace: LANDING_TRACE,
    presentedPrompt: {
      text: 'Build a beautiful coming-soon website for my cupcake business, Crumb & Bloom. Include an email waitlist, make it feel warm and memorable, and preview it when you’re done.',
      tracePromptRole: 'nudge',
      nudgeLabel: 'Cupcake landing-page art direction and recording constraints',
    },
    deferProposedDiffPreview: true,
    staticSite: 'sites/cupcakes',
    revealFinalPreview: true,
  },
  {
    // Exercises the proposed-diff path end to end: the replayed `write_file`
    // calls travel the same route a real edit does (demo-api → `agent:show_diff`
    // → Changes panel), so this fixture fails if that wiring breaks.
    //
    // Hand-written, unlike `landing`: it is a fixture for a panel state, not a
    // recording of a turn that happened. `DEMO_TRACE` provenance rules apply to
    // `demo-traces/`, not to fixtures declared here.
    id: 'proposed-diff',
    label: 'Agent-proposed edits open the Changes panel',
    project: project('demo-proposed-diff-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-proposed-diff-thread',
        title: 'Proposed edits',
        status: 'idle',
        gitBranch: 'main',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    trace: PROPOSED_DIFF_TRACE,
  },
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
    // Per-model generation parameters. The scenario only has to seed the chat
    // model and its saved parameters — open Settings → General → Models in the
    // preview and the section renders itself against that selection. Uses an
    // OpenRouter model so all three controls are offered (a current Claude model
    // would show the reasoning ladder alone).
    id: 'model-parameters',
    label: 'Per-model reasoning / temperature / top-p',
    project: project('demo-model-parameters-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model: 'openrouter:deepseek/deepseek-v4-flash-0731',
      modelParameters: {
        'openrouter:deepseek/deepseek-v4-flash-0731': {
          reasoning: 'max',
          temperature: 1,
          topP: 0.95,
        },
        'claude-opus-5': { reasoning: 'xhigh' },
      },
    },
    threads: [
      {
        id: 'demo-model-parameters-thread',
        title: 'Model parameters',
        status: 'idle',
        // A thread-level dial so the composer footer shows its set state
        // alongside the Settings block.
        model: 'claude-opus-5',
        reasoning: 'max',
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
