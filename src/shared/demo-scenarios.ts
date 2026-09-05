import type { Project, Thread } from './types/index.ts'
import type { AcpAgentConfig } from './types/acp.ts'
import type { DemoTrace } from './demo-traces.ts'
import { LANDING_TRACE } from './demo-traces/landing.ts'

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
   * A container run already attached to the first thread, so the composer
   * banner and the run dialog's status face render without Docker.
   */
  containerRun?: import('./types/container-run.ts').ContainerRunProgress
  /** Seed host approvals so browser geometry specs can inspect the real dialog. */
  approvalRequests?: readonly {
    id: string
    title: string
    body: string
    bodyAdvice?: string
    bodyFooter?: string
    type: string
    allowRemember?: boolean
  }[]
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
      model: 'claude-sonnet-4-6',
      egressAllowlist: ['api.anthropic.com:443'],
      warnings: [],
      checkout: {
        root: '/Users/dev/projects/demo/.copse/worktrees/demo-container-thread',
        mode: 'worktree',
        branch: 'demo/lint-backlog',
      },
      log: [
        '[thread-container] carry-in 9b1b901683b9 as refs/copse/carry-in/run-demo-1',
        '[thread-container] starting copse-run-demo-1 from copse-worker:local',
        '[guest] [project-sandbox] Linux bubblewrap active (ASRT)',
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
          hostMounts: ['/run/copse', '/run/copse/state', '/run/copse/out', '/run/copse/egress'],
        },
        egress: [{ at: FIXED_TIME, origin: 'api.anthropic.com:443', event: 'connect' }],
        result: {
          threadId: 'demo-container-thread',
          stopReason: 'completed',
          usage: { inputTokens: 412_310, outputTokens: 38_902 },
          promptsAttempted: 0,
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
          containment: { declared: true, declineReason: null, projectSandbox: true },
          toolNames: ['run_shell', 'read_file', 'write_file'],
          finalText:
            'Cleared the lint backlog in three commits. The push is waiting for your review.',
        },
        carryOut: { expected: true, ref: 'refs/copse/runs/run-demo-1', error: null },
        containerExit: 0,
        teardown: 'removed',
        cleanupError: null,
        secretCanary: { present: false, detail: 'canary absent from every surface' },
      },
      error: null,
    },
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
        body: 'COREPACK_HOME="$TMPDIR/copse-corepack" corepack pnpm run check:oracle',
        bodyAdvice:
          'The project sandbox would block this command:\n• Downloads package-manager binaries (corepack)',
        bodyFooter: 'Allow running it once outside the sandbox?',
        type: 'shell',
      },
      {
        id: 'demo-approval-grouped-shell-commands-syntax',
        title: 'Run outside sandbox?',
        body: 'COREPACK_HOME="$TMPDIR/copse-corepack" corepack pnpm run check:e2e-syntax',
        bodyAdvice:
          'The project sandbox would block this command:\n• Downloads package-manager binaries (corepack)',
        bodyFooter: 'Allow running it once outside the sandbox?',
        type: 'shell',
      },
      {
        id: 'demo-approval-grouped-shell-commands-test',
        title: 'Run outside sandbox?',
        body: 'COREPACK_HOME="$TMPDIR/copse-corepack" corepack pnpm test',
        bodyAdvice:
          'The project sandbox would block this command:\n• Downloads package-manager binaries (corepack)',
        bodyFooter: 'Allow running it once outside the sandbox?',
        type: 'shell',
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
