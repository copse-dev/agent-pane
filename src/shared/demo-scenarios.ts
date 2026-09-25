import type { ChatGptPlanStatus } from './types/chatgpt-plan.ts'
import type { ProfileVaultStatus } from './types/profile-vault.ts'
import type { Project, Thread } from './types/index.ts'
import type { AppleProjectState } from './types/apple-development.ts'
import type { AcpAgentConfig } from './types/acp.ts'
import type { PluginInstallReview } from './types/plugin-installs.ts'
import type { McpServerStatus } from './types/mcp.ts'
import type { DemoTrace } from './demo-traces.ts'
import type { FollowUpSuggestion } from './follow-ups/types.ts'
import type { ToolPermissionCatalog } from './types/tool-permissions.ts'
import type { GhPrDetails } from './types/git.ts'
import { LANDING_TRACE } from './demo-traces/landing.ts'
import { SITE_TOUR_SCENARIOS } from './demo-site-tour.ts'

const FIXED_TIME = Date.UTC(2026, 6, 17, 9, 0, 0)
const FOOTER_INPUT_TOKENS = 50_000
const FOOTER_OUTPUT_TOKENS = 1_800

const DEMO_CODEX_ACP_AGENT = {
  id: 'codex-acp',
  title: 'Codex',
  command: 'codex-acp',
  args: [],
  enabled: true,
} satisfies AcpAgentConfig

export interface DemoScenario {
  id: string
  label: string
  chatGptPlan?: ChatGptPlanStatus
  project: Project
  threads: Thread[]
  /**
   * Further projects in the sidebar, each with its own threads. The scenario's
   * `project` stays the one that opens; these are the ones never opened this
   * session, so a spec can see what the sidebar lists for them.
   */
  otherProjects?: ReadonlyArray<{ project: Project; threads: Thread[] }>
  settings: Readonly<Record<string, unknown>>
  /** Optional read-only PR showcase data for the browser demo's PR panel. */
  pullRequests?: GhPrDetails[]
  /** Static native-vault state for browser demonstrations; never unlocks real credentials. */
  profileVault?: ProfileVaultStatus
  /**
   * A recorded turn the demo can replay when its prompt is submitted. Scenarios
   * without one are static fixtures for visual tests; a scenario with one is a
   * walkthrough — the composer types the prompt and the answer streams back
   * through the ordinary chunk path.
   */
  trace?: DemoTrace
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
  /**
   * Never answer transcript hydration (`threads:load-messages`), freezing an
   * unhydrated thread in its mid-switch state. The conversation's hydration
   * notice is only ever on screen for the moment a transcript takes to read;
   * this holds that moment open so the visual spec can assert and capture it.
   */
  holdThreadHydration?: boolean
  /**
   * Reject transcript hydration (`threads:load-messages`), leaving an
   * unhydrated thread in its failed state: the conversation must own up with
   * a failure line — and keep the live activity row — instead of a
   * "Loading…" notice that never finishes.
   */
  failThreadHydration?: boolean
  /**
   * Answer `vnc:discover` with these ports instead of scanning a host the browser
   * demo does not have. The discovered-port list only renders when a machine
   * exposes more than one port, and the first is selected on arrival — which is
   * the only way to reach `.vnc-discovered-port.selected` deterministically.
   */
  vncDiscoveredPorts?: readonly number[]
  /**
   * A login the browser demo's credential store already holds for every
   * desktop target. The demo has no OS keychain, so this is what reaches the
   * selected device's "Signed in as …" details and its forget action.
   */
  vncSavedLogin?: { readonly username: string }
  /**
   * A container run already attached to the first thread, so the composer
   * banner and the run dialog's status face render without Docker.
   */
  containerRun?: import('./types/container-run.ts').ContainerRunProgress
  /** Seed host approvals so browser geometry specs can inspect the real dialog. */
  approvalRequests?: readonly {
    id: string
    threadId?: string
    title: string
    body: string
    bodyAdvice?: string
    bodyFooter?: string
    type: string
    allowRemember?: boolean
  }[]
  /** Seed `ask_user` questions so a browser spec can answer them from the Activity view. */
  askUserRequests?: readonly {
    id: string
    /** The thread the question belongs to, as on a real ask-user event. */
    threadId?: string
    questions: readonly { question: string; options?: readonly string[] }[]
  }[]
  /** Browser-hosted state for the first-party Apple Development panel. */
  appleDevelopmentState?: AppleProjectState
  /** Seed auto-update prompts so a browser spec can inspect the real dialog. */
  updatePromptRequests?: readonly {
    id: string
    message: string
    detail?: string
    changelog?: readonly { version: string; notes: string }[]
    changelogUrl?: string
    buttons: readonly string[]
    defaultIndex?: number
    cancelIndex?: number
  }[]
  /**
   * Answer `plugins:prepare-install` with this review. The browser demo cannot
   * download a package, so this is what reaches the real install review dialog.
   */
  pluginInstallReview?: PluginInstallReview
  /**
   * MCP servers the demo reports as configured, with the per-tool permission
   * catalog Settings → Permissions lists for them. Scenarios without one show
   * the default mail-server fixture.
   */
  mcpServers?: readonly McpServerStatus[]
  toolPermissions?: ToolPermissionCatalog
  /**
   * What the follow-up model offers once the active thread's last turn ends.
   * The demo has no model to ask, so without this no bubbles appear.
   */
  followUps?: readonly FollowUpSuggestion[]
  /** The description the demo proposes when a visitor opens Create PR. */
  prBody?: string
  /** Uncommitted line counts the demo's working tree reports for the Changes chip. */
  changeStats?: { readonly additions: number; readonly deletions: number }
  /** Unlanded work per thread id, for the sidebar's "changes" glyph. */
  threadChanges?: Readonly<Record<string, { readonly dirty: boolean; readonly unpushed?: number }>>
}

export const FOOTER_COMPACT_EXPECTATIONS = {
  tokenLabel: `${((FOOTER_INPUT_TOKENS + FOOTER_OUTPUT_TOKENS) / 1000).toFixed(1)}k tokens`,
} as const

/** Prompt a walkthrough submits: exactly the user text captured in its source trace. */
export function demoScenarioPrompt(scenario: DemoScenario): string {
  return scenario.trace?.prompt ?? ''
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

// A fenced JSON block is the shape issue #2486 reported: highlight.js tags object
// keys `.hljs-attr` and their values `.hljs-string`, which the vendored Dark+
// palette painted light blue and salmon onto a near-white light-theme surface.
// Comments and numbers come along because they are the other three token classes
// the palette colours, so one block exercises the whole thing.
const syntaxContrastContent = [
  'Here is the resolved model configuration:',
  '',
  '```json',
  '{',
  '  "model": "claude-opus-4",',
  '  "temperature": 0.2,',
  '  "maxTokens": 8192,',
  '  "stream": true',
  '}',
  '```',
  '',
  'and the loop that reads it:',
  '',
  '```ts',
  '// Resolve the model for this turn.',
  'function resolveModel(settings: Settings): string {',
  "  return settings.model ?? 'claude-opus-4'",
  '}',
  '```',
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

// Authored layout fixture, not a recorded claim about work performed.
const readingLayoutContent = [
  'A response should be comfortable to read from the first streamed sentence through the final answer. The prose stays within a readable measure while the surrounding chat can still hold wider tool output.',
  '',
  'This second paragraph checks the separation between ideas. Short answers should keep their natural height, and longer explanations should wrap without pushing the chat pane sideways.',
  '',
  '## What changed',
  '',
  '- **A readable column:** keeps long lines from crossing the entire window.',
  '- Paragraphs and sections have enough separation to scan.',
  '  - Nested details retain their indentation.',
  '  - A second nested item checks the list rhythm.',
  '- Pending markdown uses the same text size as the completed answer.',
  '- A [**bold link**](https://example.com) keeps the link colour.',
  '',
  '### Review the details',
  '',
  'Inline paths such as `src/renderer/styles/global/conversation.css` remain selectable. A long command below scrolls within its code block.',
  '',
  '```sh',
  'pnpm run test:demo --spec tests/demo/chat-reading-layout.demo.ts --spec tests/demo/markdown-list-indent.demo.ts --spec tests/demo/chat-layout-styling.demo.ts',
  '```',
  '',
  '| Surface | Expected behavior |',
  '| --- | --- |',
  '| Prose | Wrap to the available reading width |',
  '| Code | Scroll inside the fenced block |',
  '| Tool output | Keep the existing trace typography |',
  '',
  '> A quote remains part of the response and keeps its own visual treatment.',
  '',
  '## Limits',
  '',
  'This is a deterministic layout fixture. It does not claim that an agent inspected files or ran these checks.',
].join('\n')

const READING_LAYOUT_TRACE: DemoTrace = {
  id: 'chat-reading-layout',
  label: 'Reading layout with a tool and streamed markdown',
  prompt: 'Show the reading layout with a streamed response.',
  steps: [
    { chunk: { type: 'text', text: 'I will inspect the sample before explaining it.\n\n' } },
    {
      chunk: {
        type: 'tool_call',
        toolCall: { id: 'reading-layout-read', name: 'read_file', args: { path: 'sample.ts' } },
      },
      delayMs: 800,
    },
    {
      chunk: {
        type: 'tool_result',
        toolCallId: 'reading-layout-read',
        result: 'export const sample = true',
        isError: false,
      },
      delayMs: 800,
    },
    { chunk: { type: 'text', text: readingLayoutContent } },
    { chunk: { type: 'done', stopReason: 'end_turn' } },
  ],
}

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

// A stand-in browser capture for the concise-thread scenarios: the screenshot a
// tool returned is the "work output" that view keeps on screen.
const CONCISE_SCREENSHOT = `data:image/svg+xml;base64,${btoa(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">',
    '<rect width="480" height="270" fill="#f4f1ea"/>',
    '<rect width="480" height="36" fill="#2f3a2f"/>',
    '<text x="16" y="23" font-family="sans-serif" font-size="14" fill="#fff">Settings</text>',
    '<rect x="16" y="56" width="200" height="14" rx="3" fill="#c9c2b3"/>',
    '<rect x="16" y="84" width="448" height="44" rx="6" fill="#fff" stroke="#d8d2c4"/>',
    '<rect x="16" y="140" width="448" height="44" rx="6" fill="#fff" stroke="#d8d2c4"/>',
    '<rect x="384" y="210" width="80" height="32" rx="6" fill="#4f7a4f"/>',
    '<text x="405" y="231" font-family="sans-serif" font-size="13" fill="#fff">Save</text>',
    '</svg>',
  ].join(''),
)}`

/**
 * One finished turn — narration, reads, a failed then retried command, a
 * screenshot and a closing summary — attributed to `model`, so the same
 * transcript renders concisely for a capable model and in full otherwise.
 */
function conciseThreadMessages(model: string, live: boolean): Thread['messages'] {
  return [
    {
      id: `concise-user-${model}`,
      role: 'user',
      content: 'Fix the settings form so Save stays aligned on narrow windows.',
      toolCalls: [],
      createdAt: FIXED_TIME,
    },
    {
      id: `concise-step-1-${model}`,
      role: 'assistant',
      model,
      reasoning: 'The Save button is absolutely positioned; check the form layout first.',
      content: 'Let me look at how the settings form lays out its footer.',
      toolCalls: [
        {
          id: `concise-read-${model}`,
          name: 'read_file',
          args: { path: 'src/renderer/views/settings-dialog.ts' },
          status: 'done',
          result: 'export function mountSettings() { … }',
        },
        {
          id: `concise-edit-${model}`,
          name: 'str_replace',
          args: { path: 'src/renderer/styles/settings.css' },
          status: 'done',
          result: 'Replaced 1 occurrence.',
          editStats: { additions: 4, deletions: 2 },
        },
        {
          id: `concise-test-fail-${model}`,
          name: 'run_shell',
          args: { command: 'pnpm test -- settings-forms' },
          status: 'error',
          result: 'Error: settings-forms.test.ts expected footer to use grid',
        },
        {
          id: `concise-test-pass-${model}`,
          name: 'run_shell',
          args: { command: 'pnpm test -- settings-forms' },
          status: live ? 'running' : 'done',
          result: live ? null : 'ℹ pass 12',
        },
      ],
      createdAt: FIXED_TIME + 1_000,
    },
    ...(live
      ? []
      : [
          {
            id: `concise-step-2-${model}`,
            role: 'assistant' as const,
            model,
            content: 'Capturing the narrow layout to confirm.',
            toolCalls: [
              {
                id: `concise-shot-${model}`,
                name: 'browser_screenshot',
                args: { width: 480 },
                status: 'done' as const,
                result: 'Captured the settings dialog at 480px.',
                images: [
                  {
                    dataUrl: CONCISE_SCREENSHOT,
                    name: 'settings-480px.png',
                    kind: 'screenshot' as const,
                  },
                ],
              },
            ],
            createdAt: FIXED_TIME + 2_000,
          },
          {
            id: `concise-summary-${model}`,
            role: 'assistant' as const,
            model,
            content:
              'Save now stays pinned to the form footer at every width: the footer is a grid instead of an absolutely positioned row. The settings form tests pass.',
            toolCalls: [
              {
                id: `concise-audit-${model}`,
                name: 'workspace_edit_audit',
                args: {},
                status: 'done' as const,
                result: 'Audit complete.',
              },
            ],
            createdAt: FIXED_TIME + 3_000,
          },
        ]),
  ]
}

/**
 * A longer finished thread for the concise view: a tool-and-screenshot turn,
 * back-to-back text answers, a tool turn that ends in text only, a one-line
 * answer and a closing screenshot turn. It exercises the spacing between
 * prompts, hidden process bubbles and replies that a single turn cannot.
 */
function conciseMultiTurnMessages(model: string): Thread['messages'] {
  const turn = (
    n: number,
    prompt: string,
    replies: string[],
    { tools = false, screenshot = false }: { tools?: boolean; screenshot?: boolean } = {},
  ): Thread['messages'] => {
    const at = FIXED_TIME + n * 10_000
    return [
      {
        id: `concise-multi-user-${String(n)}`,
        role: 'user',
        content: prompt,
        toolCalls: [],
        createdAt: at,
      },
      ...(tools
        ? [
            {
              id: `concise-multi-steps-${String(n)}`,
              role: 'assistant' as const,
              model,
              content: 'Checking the code.',
              toolCalls: [
                {
                  id: `concise-multi-read-${String(n)}`,
                  name: 'read_file',
                  args: { path: 'src/renderer/views/settings-dialog.ts' },
                  status: 'done' as const,
                  result: 'export function mountSettings() { … }',
                },
                {
                  id: `concise-multi-edit-${String(n)}`,
                  name: 'str_replace',
                  args: { path: 'src/renderer/styles/settings.css' },
                  status: 'done' as const,
                  result: 'Replaced 1 occurrence.',
                  editStats: { additions: 3, deletions: 1 },
                },
              ],
              createdAt: at + 1,
            },
          ]
        : []),
      ...(screenshot
        ? [
            {
              id: `concise-multi-shot-${String(n)}`,
              role: 'assistant' as const,
              model,
              content: 'Capturing the narrow layout.',
              toolCalls: [
                {
                  id: `concise-multi-capture-${String(n)}`,
                  name: 'browser_screenshot',
                  args: { width: 480 },
                  status: 'done' as const,
                  result: 'Captured the settings dialog at 480px.',
                  images: [
                    {
                      dataUrl: CONCISE_SCREENSHOT,
                      name: 'settings-480px.png',
                      kind: 'screenshot' as const,
                    },
                  ],
                },
              ],
              createdAt: at + 2,
            },
          ]
        : []),
      ...replies.map((content, i) => ({
        id: `concise-multi-reply-${String(n)}-${String(i)}`,
        role: 'assistant' as const,
        model,
        content,
        toolCalls: [],
        createdAt: at + 3 + i,
      })),
    ]
  }
  return [
    ...turn(
      1,
      'Fix the settings form so Save stays aligned on narrow windows.',
      ['Save now stays pinned to the footer at every width. The settings form tests pass.'],
      { tools: true, screenshot: true },
    ),
    ...turn(2, 'Why was it misaligned?', [
      'The footer was absolutely positioned, so it ignored the form width.',
      'I switched it to a grid so it follows the content box.',
    ]),
    ...turn(3, 'Rename the helper too.', ['Renamed `pinFooter` to `layoutFooter` in 3 files.'], {
      tools: true,
    }),
    ...turn(4, 'Anything else?', ['No. Nothing else needs changing.']),
    ...turn(5, 'Show me the narrow layout again.', ['Here is the 480px layout after the rename.'], {
      tools: true,
      screenshot: true,
    }),
  ]
}

/** `enabled` is the experimental Concise threads setting; on unless a scenario opts out. */
function conciseThreadScenario(
  id: string,
  label: string,
  model: string,
  {
    live = false,
    enabled = true,
    multiTurn = false,
  }: { live?: boolean; enabled?: boolean; multiTurn?: boolean } = {},
): DemoScenario {
  return {
    id,
    label,
    project: project(`demo-${id}-project`),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model,
      conciseThreadsEnabled: enabled,
    },
    threads: [
      {
        id: `demo-${id}-thread`,
        title: 'Concise thread view',
        status: live ? 'running' : 'idle',
        model,
        messages: multiTurn
          ? [
              ...conciseMultiTurnMessages(model),
              ...(live ? conciseThreadMessages(model, true) : []),
            ]
          : conciseThreadMessages(model, live),
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  }
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  // The first scenario remains the marketing landing walkthrough.
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
      registeredAcpAgents: [DEMO_CODEX_ACP_AGENT],
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
    deferProposedDiffPreview: true,
    staticSite: 'sites/cupcakes',
    revealFinalPreview: true,
  },
  {
    // Exercises the proposed-diff path end to end: the replayed `write_file`
    // calls travel the same route a real edit does (demo-api → `agent:show-diff`
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
    id: 'chat-reading-layout',
    label: 'Readable assistant responses',
    project: project('demo-reading-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-reading-thread',
        title: 'Readable assistant responses',
        status: 'idle',
        messages: [
          {
            id: 'demo-reading-user',
            role: 'user',
            content: 'Show an answer with paragraphs, lists, and code.',
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
          {
            id: 'demo-reading-assistant',
            role: 'assistant',
            content: readingLayoutContent,
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    trace: READING_LAYOUT_TRACE,
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
    id: 'container-run',
    label: 'Unattended container run',
    project: project('demo-container-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model: 'claude-sonnet-4-6',
      containerRunsEnabled: true,
    },
    threads: [
      {
        id: 'demo-container-thread',
        title: 'Clear the lint backlog',
        status: 'idle',
        gitBranch: 'demo/lint-backlog',
        messages: [
          {
            id: 'demo-container-user',
            role: 'user',
            content: 'Clear the lint backlog and open a PR.',
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
        ],
        usage: { inputTokens: 412_310, outputTokens: 38_902 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    containerRun: {
      threadId: 'demo-container-thread',
      runtimeId: 'run-demo-1',
      phase: 'finished',
      startedAt: FIXED_TIME,
      finishedAt: FIXED_TIME + 23 * 60_000,
      prompt: 'Clear the lint suppression backlog in the renderer views',
      model: 'claude-sonnet-4-6',
      egressAllowlist: ['api.anthropic.com:443'],
      credential: 'key',
      settings: {
        budgets: { wallClockMs: 180_000, tokenCeiling: 20_000 },
        installDependencies: false,
      },
      warnings: [],
      checkout: {
        root: '/Users/dev/projects/demo/.copse/worktrees/demo-container-thread',
        mode: 'worktree',
        branch: 'demo/lint-backlog',
      },
      log: [
        '[thread-container] carry-in 9b1b901683b9 as refs/copse/carry-in/run-demo-1',
        '[thread-container] starting copse-run-demo-1 from copse-worker:local',
        '[guest] [worker] egress proxy on 127.0.0.1:3128, token-gated',
        '[guest] [worker] project sandbox: none; the container is the sandbox',
        '[guest] [worker] done: completed; prompts=0 deferrals=1 commits=3',
        '[thread-container] carry-out fetched to refs/copse/runs/run-demo-1',
      ],
      record: {
        runtimeId: 'run-demo-1',
        threadId: 'demo-container-thread',
        startedAt: FIXED_TIME,
        finishedAt: FIXED_TIME + 23 * 60_000,
        image: 'copse-worker:local',
        imageDigest: 'sha256:0c1f2e3d4c5b6a798877665544332211aabbccddeeff00112233445566778899',
        attestation: {
          runtimeId: 'run-demo-1',
          image: 'copse-worker:local',
          user: 1001,
          readOnlyRootfs: true,
          capDropAll: true,
          noNewPrivileges: true,
          pidsLimit: 512,
          memoryLimit: '4g',
          network: 'brokered',
          egressAllowlist: ['api.anthropic.com:443'],
          hostMounts: ['/run/copse', '/run/copse/state', '/run/copse/out'],
        },
        egress: [{ at: FIXED_TIME, origin: 'api.anthropic.com:443', event: 'connect' }],
        result: {
          threadId: 'demo-container-thread',
          stopReason: 'completed',
          usage: { inputTokens: 412_310, outputTokens: 38_902 },
          harness: 'copse',
          promptsAttempted: 0,
          denials: [],
          deferrals: [
            {
              id: 'd1',
              title: 'Outward effect needs review',
              subject: 'shell command (arguments omitted)',
              reasons: ['git push publishes commits to a remote'],
            },
          ],
          commits: [
            'a1b2c3d fix(lint): remove unused imports across src/main',
            'b2c3d4e fix(lint): prefer nullish coalescing in providers',
            'c3d4e5f chore: rerun formatter',
          ],
          containment: { declared: true, declineReason: null, projectSandbox: false },
          toolNames: ['run_shell', 'read_file', 'write_file'],
          finalText:
            'Cleared the lint backlog in three commits. The push is waiting for your review.',
        },
        transcript: [
          {
            id: 'guest-1',
            role: 'assistant',
            content: 'Reading the lint report to see which suppressions are still needed.',
            toolCalls: [
              {
                id: 'guest-t1',
                name: 'run_shell',
                args: { command: 'pnpm run lint -- --format json' },
                status: 'done',
                result: '14 suppressions, 11 of them for rules that no longer fire',
              },
              {
                id: 'guest-t2',
                name: 'str_replace',
                args: { path: 'src/main/providers/openai.ts' },
                status: 'done',
                result: 'Replaced 1 occurrence',
                editStats: { additions: 1, deletions: 3 },
              },
            ],
            createdAt: FIXED_TIME + 60_000,
          },
          {
            id: 'guest-2',
            role: 'assistant',
            content:
              'Cleared the lint backlog in three commits. The push is waiting for your review.',
            toolCalls: [],
            createdAt: FIXED_TIME + 22 * 60_000,
          },
        ],
        carryIn: { sha: '9b1b901683b9f0e5b2a3c4d5e6f708192a3b4c5d', dirty: false },
        carryOut: { expected: true, ref: 'refs/copse/runs/run-demo-1', error: null },
        containerExit: 0,
        credential: 'key',
        teardown: 'removed',
        cleanupError: null,
        secretCanary: { present: false, detail: 'canary absent from every surface' },
      },
      error: null,
      continuedFrom: null,
    },
  },
  {
    id: 'balanced-model-label',
    label: 'Balanced model rule label',
    trace: {
      id: 'balanced-model-resolution',
      label: 'Balanced resolves before the first token',
      prompt: 'Show the concrete model for this turn.',
      steps: [
        {
          chunk: {
            type: 'turn_parameters',
            model: 'claude-sonnet-4-6',
            parameters: {},
            requestedModel: 'auto:balanced',
          },
        },
        { delayMs: 5000, chunk: { type: 'text', text: 'This turn runs on Claude Sonnet 4.6.' } },
        { chunk: { type: 'done', stopReason: 'end_turn' } },
      ],
    },
    project: project('demo-balanced-model-label-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model: 'auto:balanced',
    },
    threads: [
      {
        id: 'demo-balanced-model-label-thread',
        title: 'Balanced model label',
        status: 'idle',
        model: 'auto:balanced',
        messages: [
          {
            id: 'demo-balanced-model-label-user',
            role: 'user',
            content: 'Keep this conversation on the balanced model rule.',
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
    id: 'prompt-model-first-ask',
    label: 'Prompt matching without transcript diagnostics',
    trace: {
      id: 'prompt-model-first-ask',
      label: 'The first ask pins the model in the picker',
      prompt: 'Check for typos in the README',
      steps: [
        {
          chunk: {
            type: 'turn_parameters',
            model: 'claude-haiku-4-5',
            parameters: {},
            requestedModel: 'auto:match-prompt',
          },
        },
        { delayMs: 2000, chunk: { type: 'text', text: 'I’ll check the README for typos.' } },
        { chunk: { type: 'done', stopReason: 'end_turn' } },
      ],
    },
    project: project('demo-prompt-model-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      model: 'auto:match-prompt',
    },
    threads: [
      {
        id: 'demo-prompt-model-thread',
        title: 'README typo check',
        status: 'idle',
        model: 'auto:match-prompt',
        messages: [],
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
      containerRunsEnabled: true,
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
              {
                id: 'demo-custom-agent-call',
                name: 'task',
                args: {
                  subagent_type: 'security-reviewer',
                  prompt: 'Review the authentication changes for security regressions.',
                },
                status: 'done',
                result: 'No authentication bypasses found.',
                subagent: {
                  id: 'demo-custom-agent-session',
                  kind: 'custom',
                  status: 'done',
                  prompt: 'Review the authentication changes for security regressions.',
                  summary: 'No authentication bypasses found.',
                  model: 'claude-opus-4-8',
                  agentName: 'security-reviewer',
                  agentColor: '#c084fc',
                  messages: [
                    {
                      id: 'demo-custom-agent-message-1',
                      role: 'assistant',
                      content: 'No authentication bypasses found.',
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
    id: 'approval-thread-switch-scroll',
    label: 'Switch between threads awaiting permission',
    project: project('demo-approval-scroll-project'),
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
    threads: ['a', 'b'].map((suffix): Thread => ({
      id: `demo-approval-scroll-${suffix}`,
      title: `Permission wait ${suffix.toUpperCase()}`,
      status: 'running',
      messages: Array.from({ length: 20 }, (_, index) => ({
        id: `approval-scroll-${suffix}-${String(index)}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content:
          index === 19
            ? `The checks are ready. I need permission to run command ${suffix.toUpperCase()}.`
            : index % 2 === 0
              ? `Review step ${String(index / 2 + 1)} for thread ${suffix.toUpperCase()}.`
              : 'I checked the relevant code and recorded the result. The next check will confirm the remaining behavior.',
        toolCalls:
          index === 19
            ? [
                {
                  id: `approval-scroll-tool-${suffix}`,
                  name: 'run_shell',
                  args: { command: `node scripts/check-${suffix}.mjs` },
                  status: 'running',
                  result: '',
                },
              ]
            : [],
        createdAt: FIXED_TIME + index,
      })),
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    })),
    approvalRequests: ['a', 'b'].map((suffix) => ({
      id: `approval-scroll-request-${suffix}`,
      threadId: `demo-approval-scroll-${suffix}`,
      title: 'Run outside sandbox?',
      body: `node scripts/check-${suffix}.mjs`,
      bodyFooter: 'Allow running it once outside the sandbox?',
      type: 'shell',
    })),
  },
  {
    id: 'approval-light-accent',
    label: 'Light-theme approval with a bright accent',
    project: project('demo-approval-light-accent-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'light',
      uiAccentColor: '#20FD85',
      uiTintColor: '#244C25',
      uiTintStrength: 'subtle',
    },
    threads: [
      {
        id: 'demo-approval-light-accent-thread',
        title: 'Approval contrast',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    approvalRequests: [
      {
        id: 'demo-approval-light-accent-request',
        title: 'Run outside sandbox?',
        body: 'npm install',
        bodyAdvice:
          'The project sandbox would block this command:\n• Installs or updates packages, which downloads and runs code from the internet',
        bodyFooter: 'Allow running it once outside the sandbox?',
        type: 'shell',
      },
    ],
  },
  {
    // Companion to `approval-light-accent`: same bright accent, same light theme,
    // but aimed at the surfaces issue #2486/#2488/#2483 reported rather than the
    // approval dialog. The accent matters — light derives `--accent` as 30% of it
    // mixed with black, so a bright one makes the derived tier unmistakably dark
    // and any control that fills with it instead of `--accent-fill` shows up.
    id: 'light-contrast-surfaces',
    label: 'Light-theme syntax, fills, and selection',
    project: project('demo-light-contrast-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'light',
      uiAccentColor: '#20FD85',
      uiTintColor: '#244C25',
      uiTintStrength: 'subtle',
    },
    threads: [
      {
        id: 'demo-light-contrast-thread',
        title: 'Light-theme contrast',
        status: 'idle',
        messages: [
          {
            id: 'demo-light-contrast-assistant',
            role: 'assistant',
            content: syntaxContrastContent,
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
    id: 'approval-grouped-shell-commands',
    label: 'Grouped outside-sandbox command approval',
    project: project('demo-approval-grouped-shell-commands-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-approval-grouped-shell-commands-thread',
        title: 'Measuring oracle execution time',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    approvalRequests: [
      {
        id: 'demo-approval-grouped-shell-commands-oracle',
        title: 'Run outside sandbox?',
        body: 'node .tmp/dep-candidates.mjs',
        bodyAdvice:
          "The project sandbox would block this command:\n• Runs a script file from the project, so Copse can't tell what it does",
        bodyFooter: 'Allow running it once outside the sandbox?',
        type: 'shell',
      },
      {
        id: 'demo-approval-grouped-shell-commands-syntax',
        title: 'Run outside sandbox?',
        body: 'mkdir -p node_modules && ln -s ../.tmp/validation/node_modules.partial/.pnpm/esbuild@0.28.2/node_modules/esbuild node_modules/esbuild',
        bodyAdvice:
          'The project sandbox would block this command:\n• Reaches outside the project with a ../ path',
        bodyFooter: 'Allow running it once outside the sandbox?',
        type: 'shell',
      },
      {
        id: 'demo-approval-grouped-shell-commands-test',
        title: 'Run outside sandbox?',
        body: 'ln -s ../.tmp/validation/node_modules.partial/.pnpm/esbuild@0.28.2/node_modules/esbuild node_modules/esbuild',
        bodyAdvice:
          'The project sandbox would block this command:\n• Reaches outside the project with a ../ path',
        bodyFooter: 'Allow running it once outside the sandbox?',
        type: 'shell',
      },
    ],
  },
  {
    id: 'product-announcements-fresh',
    label: 'Product announcements — fresh',
    project: project('demo-announcements-project'),
    settings: { onboardingCompleted: false, theme: 'dark', acknowledgedProductAnnouncements: [] },
    threads: [
      {
        id: 'demo-announcements-thread',
        title: 'Polish the release',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'product-announcements-existing',
    label: 'Product announcements — existing',
    project: project('demo-announcements-project'),
    settings: { onboardingCompleted: true, theme: 'dark', acknowledgedProductAnnouncements: [] },
    threads: [
      {
        id: 'demo-announcements-thread',
        title: 'Polish the release',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'product-announcements-update',
    label: 'Product announcements — update',
    project: project('demo-announcements-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      acknowledgedProductAnnouncements: ['demo-compact-released'],
    },
    threads: [
      {
        id: 'demo-announcements-thread',
        title: 'Polish the release',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'product-announcements-seen',
    label: 'Product announcements — seen',
    project: project('demo-announcements-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      acknowledgedProductAnnouncements: ['demo-compact-released', 'demo-announcements-ready'],
    },
    threads: [
      {
        id: 'demo-announcements-thread',
        title: 'Polish the release',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'update-prompt-changelog',
    label: 'Update prompt listing every missed release',
    project: project('demo-update-prompt-changelog-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-update-prompt-changelog-thread',
        title: 'Weekly release cadence',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    updatePromptRequests: [
      {
        id: 'demo-update-prompt-changelog',
        message: 'Copse 0.1.0-beta.11 is available',
        detail: 'Download the update now? You can install it immediately once downloaded.',
        changelog: [
          {
            version: '0.1.0-beta.11',
            notes: [
              '- The Browser pane restores its tabs when Copse is reopened.',
              '- Tool calls that miss a numeric bound run at the cap instead of failing.',
              '',
              '## Known issues',
              '',
              '- Restored tabs do not keep their scroll position.',
            ].join('\n'),
          },
          {
            version: '0.1.0-beta.10',
            // Release notes arrive over the network: markup must render inert.
            notes:
              '- Faster `find_files` on large repositories.\n- <img src="x" onerror="document.body.dataset.pwned=1"><script>document.body.dataset.pwned=1</script>Hardened update checks.',
          },
          { version: '0.1.0-beta.9', notes: '' },
        ],
        changelogUrl: 'https://github.com/copse-dev/copse-releases/releases',
        buttons: ['Download', 'Later'],
        defaultIndex: 0,
        cancelIndex: 1,
      },
    ],
  },
  {
    id: 'vnc-discovered-ports',
    label: 'Remote desktop discovered-port list with one selected',
    project: project('demo-vnc-discovered-ports-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      vncEnabled: true,
    },
    threads: [
      {
        id: 'demo-vnc-discovered-ports-thread',
        title: 'Remote desktop',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    vncDiscoveredPorts: [5900, 5901, 5902],
  },
  {
    id: 'vnc-saved-login',
    label: 'Remote desktop device with a saved login in a narrow rail',
    project: project('demo-vnc-saved-login-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      vncEnabled: true,
    },
    threads: [
      {
        id: 'demo-vnc-saved-login-thread',
        title: 'Remote desktop',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    vncDiscoveredPorts: [5900],
    vncSavedLogin: { username: 'saved-user' },
  },
  {
    id: 'inline-thread-reference',
    label: 'Inline thread reference chip geometry',
    project: project('demo-inline-thread-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-inline-thread-active',
        title: 'Compare thread context',
        status: 'idle',
        messages: [
          {
            id: 'demo-inline-thread-user',
            role: 'user',
            content: 'Earlier: \uFFFC confirmed the current outline.',
            attachments: [{ kind: 'thread', label: 'Existing thread reference' }],
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
      {
        id: 'demo-inline-thread-reference',
        title: 'TypeSafe inference',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 60_000,
        updatedAt: FIXED_TIME - 60_000,
      },
    ],
  },
  {
    id: 'vault-setup',
    label: 'Saved-secret encryption: migration pending',
    project: project('demo-vault-project'),
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
    threads: [],
    profileVault: {
      state: 'disabled',
      enabled: false,
      available: true,
      recovery: 'not-backed-up',
      automatic: true,
      migrationFailed: true,
      migrationBlocker: 'saved API key “openai”',
    },
  },
  {
    id: 'vault-locked',
    label: 'Saved-secret encryption: locked',
    project: project('demo-vault-project'),
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
    threads: [],
    profileVault: { state: 'locked', enabled: true, available: true, recovery: 'not-backed-up' },
  },
  {
    id: 'vault-verified',
    label: 'Saved-secret encryption: verified',
    project: project('demo-vault-project'),
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
    threads: [],
    profileVault: {
      state: 'unlocked',
      enabled: true,
      available: true,
      recovery: 'verified',
      requireAuth: false,
    },
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
    id: 'plugin-install-review',
    label: 'Plugin catalogue install review',
    project: project('demo-plugin-install-review-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-plugin-install-review-thread',
        title: 'Plugin install review',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    // The Figma package as reviewed at its pinned catalogue revision.
    pluginInstallReview: {
      token: 'demo-plugin-install-review',
      catalogId: 'https://github.com/figma/mcp-server-guide#',
      pluginId: 'figma',
      name: 'figma',
      description:
        'Figma design platform integration. Access design files, extract component information, read design tokens, and translate designs into code.',
      publisher: 'figma',
      contentHash: 'sha256:3e8e1e7aecedae788bc34903a3708818d3f161ea381583084e971a2804c298a3',
      revision: '172920731eedf414e9b22ae60017d9a5b6c9f81f',
      skillCount: 14,
      mcpServerCount: 1,
      skills: [
        'skills/figma-code-connect/SKILL.md',
        'skills/figma-create-new-file/SKILL.md',
        'skills/figma-design-to-code/SKILL.md',
        'skills/figma-generate-design/SKILL.md',
        'skills/figma-generate-diagram/SKILL.md',
        'skills/figma-generate-library/SKILL.md',
        'skills/figma-generative-plugins/SKILL.md',
        'skills/figma-implement-motion/SKILL.md',
        'skills/figma-shaders/SKILL.md',
        'skills/figma-swiftui/SKILL.md',
        'skills/figma-use-figjam/SKILL.md',
        'skills/figma-use-motion/SKILL.md',
        'skills/figma-use-slides/SKILL.md',
        'skills/figma-use/SKILL.md',
      ],
      mcpServers: [
        { name: 'figma', transport: 'streamable-http', target: 'https://mcp.figma.com/mcp' },
      ],
      warnings: [
        'MCP server "figma" won\'t connect: Figma only admits MCP apps it has approved, and Copse isn\'t one yet. The skills still work.',
      ],
      provenance: 'unsigned',
      operation: 'install',
    },
  },
  {
    id: 'mcp-sign-in',
    label: 'MCP servers that sign in with OAuth',
    project: project('demo-mcp-sign-in-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-mcp-sign-in-thread',
        title: 'MCP sign-in',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    mcpServers: [
      {
        name: 'design-system',
        transport: 'http',
        state: 'error',
        error: 'Sign-in required',
        auth: 'required',
        toolCount: 0,
        tools: [],
        origin: 'user',
        source: '/Users/demo/.cursor/mcp.json',
        originDetail: 'mcp.json',
        userEnabled: true,
        configDisabled: false,
      },
      {
        name: 'issues',
        transport: 'http',
        state: 'connected',
        auth: 'signed-in',
        toolCount: 3,
        tools: ['list_issues', 'get_issue', 'create_issue'],
        origin: 'user',
        source: '/Users/demo/.cursor/mcp.json',
        originDetail: 'mcp.json',
        userEnabled: true,
        configDisabled: false,
      },
    ],
  },
  {
    id: 'automation-permissions',
    label: 'Automation permission preferences',
    project: project('demo-automation-permissions-project', 'Copse', '/demo/copse'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-automation-permissions-thread',
        title: 'Automation permissions',
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
    id: 'thread-hydration',
    label: 'Thread switch hydration notice',
    project: project('demo-thread-hydration-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // The state under test is the moment after selecting a thread whose
    // transcript has not been read yet while its agent run is still going:
    // metadata only, no messages, status running. holdThreadHydration keeps
    // the loading notice on screen instead of letting it resolve instantly.
    holdThreadHydration: true,
    threads: [
      {
        id: 'demo-thread-hydration-thread',
        title: 'Long refactor still running',
        status: 'running',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'thread-hydration-failed',
    label: 'Thread switch hydration failure',
    project: project('demo-thread-hydration-failed-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // Same mid-switch moment as `thread-hydration`, but the transcript read
    // rejects: the pane must render the honest failure line and let the live
    // activity row through (the agent is still running).
    failThreadHydration: true,
    threads: [
      {
        id: 'demo-thread-hydration-failed-thread',
        title: 'Long refactor still running',
        status: 'running',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'apple-development',
    label: 'Apple Development test profile',
    project: project('demo-apple-development-project', 'DemoApp', '/demo/DemoApp'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    threads: [
      {
        id: 'demo-apple-development-thread',
        title: 'Apple Development demo',
        status: 'idle',
        messages: [
          {
            id: 'demo-apple-user',
            role: 'user',
            content: 'Build and test DemoApp on the selected iPhone Simulator.',
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
          {
            id: 'demo-apple-assistant',
            role: 'assistant',
            content: 'The panel shows the latest Apple Development operation for this thread.',
            toolCalls: [],
            createdAt: FIXED_TIME + 1,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME + 4_000,
      },
    ],
    appleDevelopmentState: {
      pluginEnabled: true,
      enrolled: true,
      supportedHost: true,
      toolchain: {
        developerDir: '/Applications/Xcode.app/Contents/Developer',
        version: 'Xcode 26.6',
      },
      candidates: [
        {
          id: 'ios/DemoApp.xcworkspace',
          name: 'ios/DemoApp',
          kind: 'workspace',
          schemes: ['DemoApp'],
        },
      ],
      destinations: [
        {
          id: 'platform=iOS Simulator,id=E2E-IP17-PRO',
          name: 'iPhone 17 Pro',
          platform: 'iOS Simulator',
          supported: true,
          booted: true,
        },
      ],
      metadataRequiresExecution: false,
      selection: {
        candidateId: 'ios/DemoApp.xcworkspace',
        schemeId: 'DemoApp',
        configuration: 'Debug',
        destinationId: 'platform=iOS Simulator,id=E2E-IP17-PRO',
        revision: 1,
      },
      operations: [
        {
          id: 'run-demo',
          action: 'run',
          status: 'cancelled',
          target: {
            candidateId: 'ios/DemoApp.xcworkspace',
            schemeId: 'DemoApp',
            configuration: 'Debug',
            destinationId: 'platform=iOS Simulator,id=E2E-IP17-PRO',
            revision: 1,
          },
          createdAt: FIXED_TIME + 3_000,
          updatedAt: FIXED_TIME + 4_000,
          outcome: {
            operationId: 'run-demo',
            status: 'cancelled',
            reason: 'Cancelled while waiting for the selected Simulator.',
            exitCode: null,
            diagnostics: [],
            testSummary: null,
            logArtifactId: 'apple-log:run-demo',
            outputTruncated: false,
          },
        },
        {
          id: 'test-demo',
          action: 'test',
          status: 'failed',
          target: {
            candidateId: 'ios/DemoApp.xcworkspace',
            schemeId: 'DemoApp',
            configuration: 'Debug',
            destinationId: 'platform=iOS Simulator,id=E2E-IP17-PRO',
            revision: 1,
          },
          createdAt: FIXED_TIME + 2_000,
          updatedAt: FIXED_TIME + 3_000,
          outcome: {
            operationId: 'test-demo',
            status: 'failed',
            reason: 'DemoAppTests failed with 1 failing test.',
            exitCode: 65,
            diagnostics: [],
            testSummary: { passed: 42, failed: 1, skipped: 2 },
            logArtifactId: 'apple-log:test-demo',
            outputTruncated: false,
          },
        },
        {
          id: 'build-demo',
          action: 'build',
          status: 'succeeded',
          target: {
            candidateId: 'ios/DemoApp.xcworkspace',
            schemeId: 'DemoApp',
            configuration: 'Debug',
            destinationId: 'platform=iOS Simulator,id=E2E-IP17-PRO',
            revision: 1,
          },
          createdAt: FIXED_TIME + 1_000,
          updatedAt: FIXED_TIME + 2_000,
          outcome: {
            operationId: 'build-demo',
            status: 'succeeded',
            exitCode: 0,
            diagnostics: [],
            testSummary: null,
            logArtifactId: 'apple-log:build-demo',
            outputTruncated: false,
          },
        },
      ],
      setupMessage: null,
    },
  },
  {
    id: 'sidebar-automation-fold',
    label: 'Sidebar automation fold',
    project: project('demo-automation-fold-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // One schedule with every kind of run: four waiting on the user (collapsed into one
    // row), one working, two failed (collated), and three that finished cleanly.
    // The regular thread comes first so it is the open one: a selected run would unfold its schedule.
    threads: [
      {
        id: 'demo-automation-fold-chat',
        title: 'A regular conversation',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME + 1,
        updatedAt: FIXED_TIME + 1,
      },
      ...(
        [
          ['wait-1', 'idle'],
          ['wait-2', 'idle'],
          ['wait-3', 'idle'],
          ['wait-4', 'idle'],
          ['working', 'running'],
          ['fail-1', 'error'],
          ['fail-2', 'error'],
          ['done-1', 'idle'],
          ['done-2', 'idle'],
          ['done-3', 'idle'],
        ] as const
      ).map(([suffix, status], index) => ({
        id: `demo-automation-fold-${suffix}`,
        title: 'Docs freshness',
        status,
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        automation: {
          scheduleId: 'demo-automation-fold-schedule',
          scheduleName: 'Docs freshness',
          triggeredAt: FIXED_TIME - index * 3_600_000,
        },
        createdAt: FIXED_TIME - index,
        updatedAt: FIXED_TIME - index,
      })),
    ],
    approvalRequests: ['wait-1', 'wait-2', 'wait-3', 'wait-4'].map((suffix) => ({
      id: `demo-automation-fold-approval-${suffix}`,
      threadId: `demo-automation-fold-${suffix}`,
      title: 'Run outside sandbox?',
      body: 'node scripts/check-docs.mjs',
      type: 'shell',
    })),
  },
  {
    id: 'sidebar-empty-project',
    label: 'Empty unopened project in the sidebar',
    project: project('demo-empty-active'),
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
    threads: [],
    otherProjects: [
      { project: project('demo-empty-other', 'empty-project', '/demo/empty'), threads: [] },
    ],
  },
  {
    id: 'sidebar-other-projects',
    label: 'Sidebar listing threads of projects not opened yet',
    project: project('demo-other-projects-active', 'copse-demo', '/demo/copse'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      sidebarThreadGroup: 'status',
    },
    // The open project has one thread; two more projects hold threads that are only
    // read in the background after startup, so their titles must still be listed.
    threads: [
      {
        id: 'demo-other-projects-active-chat',
        title: 'Open project thread',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    otherProjects: [
      {
        project: project('demo-other-projects-docs', 'docs-site', '/demo/docs-site'),
        threads: ['Rewrite the install guide', 'Fix broken anchors'].map((title, index) => ({
          id: `demo-other-projects-docs-${String(index)}`,
          title,
          status: 'idle' as const,
          messages: [],
          messagesLoaded: false,
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: FIXED_TIME - 10 - index,
          updatedAt: FIXED_TIME - 10 - index,
        })),
      },
      {
        project: project('demo-other-projects-api', 'api-server', '/demo/api-server'),
        threads: [
          {
            id: 'demo-other-projects-api-0',
            title: 'Add pagination to the list endpoint',
            status: 'idle' as const,
            messages: [],
            messagesLoaded: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: FIXED_TIME - 20,
            updatedAt: FIXED_TIME - 20,
          },
        ],
      },
    ],
  },
  {
    id: 'sidebar-thread-sort',
    label: 'Sidebar thread sort',
    project: project('demo-sidebar-sort-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // Newest-prompted first, as the store keeps them: neither creation nor title order.
    threads: [
      {
        id: 'demo-sidebar-sort-b',
        title: 'Fix the flaky sandbox test',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 2,
        updatedAt: FIXED_TIME - 2,
      },
      {
        id: 'demo-sidebar-sort-c',
        title: 'Update onboarding copy',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 1,
        updatedAt: FIXED_TIME - 1,
      },
      {
        id: 'demo-sidebar-sort-a',
        title: 'Add a retry to uploads',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 3,
        updatedAt: FIXED_TIME - 3,
      },
      {
        id: 'demo-sidebar-sort-d',
        title: 'Refactor auth',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 4,
        updatedAt: FIXED_TIME - 4,
      },
      {
        id: 'demo-sidebar-sort-e',
        title: 'Run the schema migration',
        status: 'running',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 5,
        updatedAt: FIXED_TIME - 5,
      },
    ],
  },
  {
    id: 'sidebar-thread-changes',
    label: 'Sidebar changes glyph',
    project: project('demo-sidebar-changes-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // Two finished threads with unlanded work, one clean, one still running.
    threadChanges: {
      'demo-sidebar-changes-commits': { dirty: false, unpushed: 2 },
      'demo-sidebar-changes-dirty': { dirty: true },
      'demo-sidebar-changes-clean': { dirty: false },
    },
    threads: [
      {
        id: 'demo-sidebar-changes-clean',
        title: 'Update onboarding copy',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 1,
        updatedAt: FIXED_TIME - 1,
      },
      {
        id: 'demo-sidebar-changes-commits',
        title: 'Refactor auth',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 2,
        updatedAt: FIXED_TIME - 2,
      },
      {
        id: 'demo-sidebar-changes-dirty',
        title: 'Add a retry to uploads',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 3,
        updatedAt: FIXED_TIME - 3,
      },
      {
        id: 'demo-sidebar-changes-running',
        title: 'Run the schema migration',
        status: 'running',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 4,
        updatedAt: FIXED_TIME - 4,
      },
    ],
  },
  {
    id: 'activity-home',
    label: 'Activity home on a new thread',
    project: project('demo-activity-home-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // The first thread is the active one and is empty, so the chat pane is the
    // Activity home. The others give it something to list: one waiting on an
    // approval, two running, one that finished while the user was elsewhere.
    threads: [
      {
        id: 'demo-activity-home-new',
        title: 'New Thread',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
      {
        id: 'demo-activity-home-refactor',
        title: 'Refactor auth',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 1,
        updatedAt: FIXED_TIME - 1,
      },
      {
        id: 'demo-activity-home-audit',
        title: 'Dependency audit',
        status: 'running',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 2,
        updatedAt: FIXED_TIME - 2,
      },
      {
        id: 'demo-activity-home-flaky',
        title: 'Fix the flaky sandbox test',
        status: 'running',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 3,
        updatedAt: FIXED_TIME - 3,
      },
      {
        id: 'demo-activity-home-copy',
        title: 'Update onboarding copy',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        unreadAt: FIXED_TIME - 60_000,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 4,
        updatedAt: FIXED_TIME - 4,
      },
    ],
    approvalRequests: [
      {
        id: 'demo-activity-home-approval',
        threadId: 'demo-activity-home-refactor',
        title: 'Run shell command?',
        body: "printf 'auth-check-passed\\n'",
        bodyAdvice: 'Auto-run for sandbox commands is disabled in Settings',
        bodyFooter: 'Allow running it once?',
        type: 'shell',
      },
    ],
  },
  {
    id: 'activity-home-project-filter',
    label: 'Activity home after a project finishes waiting',
    project: project('demo-activity-home-filter-project'),
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
    threads: [
      {
        id: 'demo-activity-filter-new',
        title: 'New Thread',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
      {
        id: 'demo-activity-filter-refactor',
        title: 'Refactor auth',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        unreadAt: FIXED_TIME - 60_000,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 1,
        updatedAt: FIXED_TIME - 1,
      },
    ],
    approvalRequests: [
      {
        id: 'demo-activity-filter-approval',
        threadId: 'demo-activity-filter-refactor',
        title: 'Run shell command?',
        body: "printf 'auth-check-passed\\n'",
        type: 'shell',
      },
    ],
  },
  {
    id: 'activity-home-automation-fold',
    label: 'Activity home with automation runs folded',
    project: project('demo-activity-fold-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // The first thread is the empty active one. Beside a working thread and one
    // finished chat, a schedule has settled five clean runs and another three failed
    // ones: each folds into a single row instead of eight.
    threads: [
      {
        id: 'demo-activity-fold-new',
        title: 'New Thread',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
      {
        id: 'demo-activity-fold-audit',
        title: 'Dependency audit',
        status: 'running',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 1,
        updatedAt: FIXED_TIME - 1,
      },
      {
        id: 'demo-activity-fold-copy',
        title: 'Update onboarding copy',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        unreadAt: FIXED_TIME - 60_000,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 2,
        updatedAt: FIXED_TIME - 2,
      },
      ...(
        [
          ['docs', 'Docs freshness', 'idle', 5],
          ['deps', 'Nightly dependency check', 'error', 3],
        ] as const
      ).flatMap(([schedule, name, status, count]) =>
        Array.from({ length: count }, (_, index) => ({
          id: `demo-activity-fold-${schedule}-${String(index)}`,
          title: name,
          status,
          messages: [],
          messagesLoaded: false,
          unreadAt: FIXED_TIME - (index + 2) * 3_600_000,
          usage: { inputTokens: 0, outputTokens: 0 },
          automation: {
            scheduleId: `demo-activity-fold-${schedule}`,
            scheduleName: name,
            triggeredAt: FIXED_TIME - (index + 2) * 3_600_000,
          },
          createdAt: FIXED_TIME - 10 - index,
          updatedAt: FIXED_TIME - 10 - index,
        })),
      ),
    ],
  },
  {
    id: 'activity-home-question',
    label: 'Activity home with a question waiting',
    project: project('demo-activity-home-question-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // The first thread is the active, empty one; the second is blocked on a question.
    threads: [
      {
        id: 'demo-activity-home-question-new',
        title: 'New Thread',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
      {
        id: 'demo-activity-home-question-schema',
        title: 'Schema bump',
        status: 'idle',
        messages: [],
        messagesLoaded: false,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME - 1,
        updatedAt: FIXED_TIME - 1,
      },
    ],
    askUserRequests: [
      {
        id: 'demo-activity-home-question',
        threadId: 'demo-activity-home-question-schema',
        questions: [
          {
            question: 'Which migration order should the schema bump use?',
            options: ['Columns first', 'Backfill first'],
          },
          { question: 'Keep the old column until the next release?' },
        ],
      },
    ],
  },
  {
    id: 'activity-home-empty',
    label: 'Activity home with nothing to list',
    project: project('demo-activity-home-empty-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
    },
    // The first-run case: one empty thread and nothing running or waiting.
    threads: [
      {
        id: 'demo-activity-home-empty-new',
        title: 'New Thread',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'pr-relations',
    label: 'PR producing and related threads',
    project: project('demo-pr-relations', 'Widgets', '/demo/widgets'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      filesPaneOpen: true,
      rightPanelMode: 'prs',
      layout: {
        projectsPaneWidth: 220,
        filesPaneWidth: 660,
        filesPaneHeight: 360,
        fileTreeWidth: 220,
      },
    },
    threads: [
      {
        id: 'pr-producer',
        title: 'Implement widget',
        status: 'idle',
        messages: [],
        prProductions: [
          {
            pr: {
              owner: 'acme',
              repo: 'widgets',
              number: 42,
              url: 'https://github.com/acme/widgets/pull/42',
            },
            source: 'pr-create',
            eventId: 'demo-create-42',
            createdAt: FIXED_TIME,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
      {
        id: 'pr-reviewer',
        title: 'Review widget',
        status: 'idle',
        messages: [
          {
            id: 'review-refs',
            role: 'user',
            content:
              'Review https://github.com/acme/widgets/pull/42 and https://github.com/acme/widgets/pull/43',
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
        ],
        prRefs: [42, 43].map((number) => ({
          owner: 'acme',
          repo: 'widgets',
          number,
          url: `https://github.com/acme/widgets/pull/${String(number)}`,
        })),
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
      {
        id: 'pr-mentioned',
        title: 'Release planning',
        status: 'idle',
        messages: [
          {
            id: 'release-ref',
            role: 'user',
            content: 'Include https://github.com/acme/widgets/pull/42 in the release.',
            toolCalls: [],
            createdAt: FIXED_TIME,
          },
        ],
        prRefs: [
          {
            owner: 'acme',
            repo: 'widgets',
            number: 42,
            url: 'https://github.com/acme/widgets/pull/42',
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
    pullRequests: [42, 43].map((number) => ({
      owner: 'acme',
      repo: 'widgets',
      number,
      url: `https://github.com/acme/widgets/pull/${String(number)}`,
      title: number === 42 ? 'Add widget support' : 'Follow up on widget review',
      state: 'OPEN',
      body: '',
      files: [],
      checks: 'success',
    })),
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
  conciseThreadScenario(
    'concise-thread',
    'Concise thread view for a capable model',
    'claude-opus-5-5',
  ),
  conciseThreadScenario(
    'concise-thread-multi',
    'Concise thread view across several turns',
    'claude-opus-5-5',
    { multiTurn: true },
  ),
  conciseThreadScenario(
    'concise-thread-multi-working',
    'Concise thread view with finished turns and a live one',
    'claude-opus-5-5',
    { multiTurn: true, live: true },
  ),
  conciseThreadScenario(
    'concise-thread-full',
    'Full thread view for a model below the concise gate',
    'gpt-4o',
  ),
  conciseThreadScenario(
    'concise-thread-working',
    'Concise thread view while a capable model works',
    'claude-opus-5-5',
    { live: true },
  ),
  conciseThreadScenario(
    'concise-thread-disabled',
    'Full thread view for a capable model while the experiment is off',
    'claude-opus-5-5',
    { enabled: false },
  ),
  {
    id: 'roadmap-chat-min-width',
    label: 'Roadmap side panel minimum chat width',
    project: project('demo-roadmap-chat-min-width-project'),
    settings: {
      onboardingCompleted: true,
      theme: 'dark',
      uiTintStrength: 'off',
      layout: { filesPaneWidth: 4000 },
    },
    threads: [
      {
        id: 'demo-roadmap-chat-min-width-thread',
        title: 'Roadmap layout bounds',
        status: 'idle',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  {
    id: 'chatgpt-plan-settings',
    label: 'ChatGPT plan onboarding and account options',
    project: project('demo-chatgpt-plan-project'),
    settings: { onboardingCompleted: true, theme: 'dark', uiTintStrength: 'off' },
    chatGptPlan: {
      activeClientId: 'demo-plan-account',
      accounts: [
        {
          clientId: 'demo-plan-account',
          label: 'you@example.com',
          connected: true,
          planEnabled: true,
        },
      ],
    },
    threads: [
      {
        id: 'demo-chatgpt-plan-thread',
        title: 'ChatGPT plan',
        model: 'chatgpt-plan:demo-plan-account#gpt-5.6-luna',
        status: 'idle',
        messages: [
          {
            id: 'plan-limit',
            role: 'assistant',
            toolCalls: [],
            content:
              '> [!CAUTION]\n> ChatGPT plan usage limit reached. Review your plan or Copse’s allowance.\n>\n> [Manage usage](https://chatgpt.com/settings/usage)',
            createdAt: FIXED_TIME,
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: FIXED_TIME,
        updatedAt: FIXED_TIME,
      },
    ],
  },
  // Authored states for the copse.dev feature tour (see demo-site-tour.ts).
  ...SITE_TOUR_SCENARIOS,
]
