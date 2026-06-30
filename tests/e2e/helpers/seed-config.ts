import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { e2eGitBranch } from './e2e-env.ts'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Mirrors `app.setPath('userData', …)` in `src/main/app-init.ts`. */
function copsePanelUserDataDir(): string {
  const override = process.env.COPSE_PANEL_USER_DATA?.trim()
  if (override) return override
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'copse-panel')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'copse-panel')
  }
  return join(homedir(), '.config', 'copse-panel')
}

const USER_DATA = copsePanelUserDataDir()
const CONFIG_PATH = join(USER_DATA, 'config.json')
const SETTINGS_PATH = join(USER_DATA, 'settings.json')

export function resetUserData(): void {
  rmSync(CONFIG_PATH, { force: true })
  rmSync(SETTINGS_PATH, { force: true })
  writeSettings({})
}

/** Fresh profile that triggers the first-run onboarding wizard. */
export function seedOnboardingFixture(): void {
  resetUserData()
  writeSettings({ onboardingCompleted: false })
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(SETTINGS_PATH, JSON.stringify({ onboardingCompleted: true, ...settings }), 'utf8')
}

/** Pin Electron window size for deterministic e2e reference screenshots. Call before reloadSession(). */
export function seedE2eViewport(
  bounds: { width: number; height: number } = { width: 1280, height: 800 },
): void {
  writeSettings({ windowBounds: bounds })
}

/** Layout for three-pane todo plan reference screenshots. Call before reloadSession(). */
export function seedE2eThreePaneLayout(): void {
  writeSettings({
    layout: {
      projectsPaneWidth: 260,
      filesPaneWidth: 480,
      fileTreeWidth: 200,
    },
  })
}

export function seedEmptyProject(
  workspaceRoot: string,
  projectId: string,
  options?: {
    subagentsEnabled?: boolean
    mockFollowUps?: boolean
    model?: string
    localServerUrl?: string
    localDefaultModel?: string
    subagentModel?: string
    localSubagentsEnabled?: boolean
    autoPortraitRightPanel?: boolean
  },
): void {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [],
    }),
    'utf8',
  )
  const settings: Record<string, unknown> = {}
  if (options?.subagentsEnabled !== undefined) {
    settings.subagentsEnabled = options.subagentsEnabled
  }
  if (options?.mockFollowUps) {
    settings.mockFollowUps = true
  }
  if (options?.model) {
    settings.model = options.model
  }
  if (options?.localServerUrl) {
    settings.localServerUrl = options.localServerUrl
  }
  if (options?.localDefaultModel) {
    settings.localDefaultModel = options.localDefaultModel
  }
  if (options?.subagentModel) {
    settings.subagentModel = options.subagentModel
  }
  if (options?.localSubagentsEnabled !== undefined) {
    settings.localSubagentsEnabled = options.localSubagentsEnabled
  }
  if (options?.autoPortraitRightPanel !== undefined) {
    settings.autoPortraitRightPanel = options.autoPortraitRightPanel
  }
  if (Object.keys(settings).length > 0) {
    writeSettings(settings)
  } else {
    writeSettings({})
  }
}

/**
 * Project with a stored OpenRouter API key, a custom model, and a (test-only)
 * `openRouterApiBase` pointing at a local fixture so the picker fetches a known
 * free/tool-capable model list without hitting the real OpenRouter API. The key
 * record matches the base64-plaintext shape `setApiKey` writes when OS secure
 * storage is unavailable, which is all `hasApiKey` needs to report it set.
 */
export function seedOpenRouterFixture(workspaceRoot: string, options?: { apiBase?: string }): void {
  const projectId = 'e2e-openrouter-project'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [],
    }),
    'utf8',
  )
  writeSettings({
    model: 'openrouter:qwen/qwen3-235b-a22b:free',
    openRouterModel: 'anthropic/claude-3.5-sonnet',
    ...(options?.apiBase ? { openRouterApiBase: options.apiBase } : {}),
    apiKey: {
      openrouter: {
        v: 1,
        enc: Buffer.from('sk-or-e2e-key', 'utf8').toString('base64'),
        plain: true,
      },
    },
  })
}

/** Tool args containing HTML-like strings that break innerHTML <pre> templates. */
export const INNERHTML_TRAP_ARGS = {
  path: 'index.html',
  content: '</pre><img src=x alt="injected"><pre>',
} as const

export function seedInnerHtmlToolArgsFixture(workspaceRoot: string): void {
  const projectId = 'e2e-innerhtml-project'
  const threadId = 'e2e-innerhtml-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'innerHTML trap test',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-innerhtml',
              role: 'assistant',
              content: 'Wrote a file with tricky HTML-like content in the arguments.',
              toolCalls: [
                {
                  id: 'tc-write-trap',
                  name: 'write_file',
                  args: INNERHTML_TRAP_ARGS,
                  status: 'done',
                  result: 'Wrote index.html',
                  editStats: { additions: 1, deletions: 0 },
                },
              ],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

export function seedMarkdownListFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-list-project'
  const threadId = 'e2e-markdown-list-thread'
  const content = [
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
    '- Persistence — `electron-store` for projects, threads, settings',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Markdown list indent',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-list',
              role: 'assistant',
              content,
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** Thematic breaks (spaced marker runs) + multi-backtick / multi-line code spans. */
export function seedMarkdownConformanceFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-conformance-project'
  const threadId = 'e2e-markdown-conformance-thread'
  const content = [
    'Thematic breaks from spaced markers:',
    '',
    '* * *',
    '',
    'Some prose between breaks.',
    '',
    '- - -',
    '',
    'Inline code spans: a multi-backtick span `` foo ` bar `` keeps the interior backtick,',
    'and ``code`` renders too.',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Markdown conformance',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-conformance',
              role: 'assistant',
              content,
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

export function seedBrowserLinkChatFixture(workspaceRoot: string): void {
  const projectId = 'e2e-browser-link-chat-project'
  const threadId = 'e2e-browser-link-chat-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Browser link chat',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-link',
              role: 'assistant',
              content: 'See [Example Domain](https://example.com) for details.',
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** Thread with a GitHub PR markdown link for PR panel e2e. */
export function seedPrPanelChatFixture(workspaceRoot: string): void {
  const projectId = 'e2e-pr-panel-project'
  const threadId = 'e2e-pr-panel-thread'
  const mockPrUrl = 'https://github.com/copse-dev/copse-panel/pull/42'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'PR panel chat',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-pr-link',
              role: 'assistant',
              content: `Track progress in [PR #42](${mockPrUrl}).`,
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** Git tool cards followed by an ordered-list summary (typical post-tool agent reply). */
export function seedGitSummaryMarkdownFixture(workspaceRoot: string): void {
  const projectId = 'e2e-git-summary-md-project'
  const threadId = 'e2e-git-summary-md-thread'
  const summary = [
    "Here's a summary of the three changed files:",
    '',
    '1. `src/main/project-sandbox/sandbox-fs-client.ts`',
    '',
    'Introduces a **sandboxed filesystem client** that routes reads and writes through a worker thread when the project sandbox is active.',
    '',
    '2. `src/main/project-sandbox/sandbox-fs-worker.ts`',
    '',
    'Worker thread that handles file operations under seatbelt constraints and reports results back to the main process.',
    '',
    '3. `src/main/project-sandbox/spawn.ts`',
    '',
    'Adds sandbox spawn helpers and wires ASRT seatbelt initialization for macOS project commands.',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Git summary markdown',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-git-summary',
              role: 'user',
              content: 'Can you summarise the git changes?',
              toolCalls: [],
              createdAt: Date.now(),
            },
            {
              id: 'msg-assistant-git-tools',
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'tc-git-status',
                  name: 'git_status',
                  args: {},
                  status: 'done',
                  result: 'M sandbox-fs-client.ts\nM sandbox-fs-worker.ts\nM spawn.ts',
                },
                {
                  id: 'tc-git-diff',
                  name: 'git_diff',
                  args: {},
                  status: 'done',
                  result: 'diff --git a/src/main/project-sandbox/spawn.ts',
                },
              ],
              createdAt: Date.now(),
            },
            {
              id: 'msg-assistant-git-summary',
              role: 'assistant',
              content: summary,
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

export function seedCodeBlockCopyFixture(workspaceRoot: string): void {
  const projectId = 'e2e-code-block-copy-project'
  const threadId = 'e2e-code-block-copy-thread'
  const content = [
    'Use this helper:',
    '',
    '```typescript',
    'export function greet(name: string) {',
    '  return `Hello, ${name}!`',
    '}',
    '```',
    '',
    'Then run:',
    '',
    '```bash',
    'npm run check',
    '```',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Code block copy',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-code-blocks',
              role: 'assistant',
              content,
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

export function seedMermaidDiagramFixture(workspaceRoot: string): void {
  const projectId = 'e2e-mermaid-project'
  const threadId = 'e2e-mermaid-thread'
  const content = [
    'Here is the agent loop:',
    '',
    '```mermaid',
    'graph TD',
    '  User --> Agent',
    '  Agent --> Tools',
    '  Tools --> Agent',
    '```',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Mermaid diagram',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-mermaid',
              role: 'assistant',
              content,
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** Seeded thread with context snapshot and token usage for footer doughnut validation. */
export function seedContextWheelFixture(workspaceRoot: string): void {
  const projectId = 'e2e-context-wheel-project'
  const threadId = 'e2e-context-wheel-thread'
  const conversationBudget = 180_000
  const conversationTokens = 54_000
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Context wheel test',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-1',
              role: 'user',
              content: 'Explain this codebase.',
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 1200, outputTokens: 800 },
          contextSnapshot: {
            contextWindow: 200_000,
            conversationBudget,
            conversationTokens,
            fillRatio: conversationTokens / conversationBudget,
            updatedAt: Date.now(),
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** Footer with long model/branch labels plus context wheel + token usage for compact layout e2e. */
export function seedFooterCompactFixture(workspaceRoot: string): {
  model: string
  branch: string
  tokenLabel: string
} {
  const projectId = 'e2e-footer-compact-project'
  const threadId = 'e2e-footer-compact-thread'
  const model = 'lmstudio:qwen/qwen3.6-35b-a3b'
  const branch = 'jkt/auto/markdown-file-links-3d2c'
  const conversationBudget = 180_000
  const conversationTokens = 9_000
  const inputTokens = 50_000
  const outputTokens = 1_800
  const tokenLabel = `${((inputTokens + outputTokens) / 1000).toFixed(1)}k tokens`
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Footer compact layout',
          status: 'idle',
          gitBranch: branch,
          messages: [
            {
              id: 'msg-user-compact',
              role: 'user',
              content: 'Check footer layout at narrow widths.',
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens, outputTokens },
          contextSnapshot: {
            contextWindow: 200_000,
            conversationBudget,
            conversationTokens,
            fillRatio: conversationTokens / conversationBudget,
            updatedAt: Date.now(),
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
  writeSettings({ model })
  return { model: 'qwen/qwen3.6-35b-a3b', branch, tokenLabel }
}

export function seedPortraitRightPanelFixture(
  workspaceRoot: string,
  autoPortraitRightPanel: boolean,
  windowBounds: { width: number; height: number } = { width: 760, height: 1180 },
): void {
  const projectId = 'e2e-portrait-right-panel-project'
  const threadId = 'e2e-portrait-right-panel-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Portrait right panel layout',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-portrait-layout',
              role: 'user',
              content: 'Open the right panel in a portrait window.',
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
  writeSettings({ autoPortraitRightPanel, windowBounds })
}

/**
 * Thread with a completed post-turn review for the inline-review-card e2e (#480).
 * The review must render INSIDE the scrolling `.messages-list` as its last child
 * (not pinned in a sibling `.conversation-review-host`), with the follow-up user
 * message staying above it.
 */
export function seedReviewInlineFixture(workspaceRoot: string): void {
  const projectId = 'e2e-review-inline-project'
  const threadId = 'e2e-review-inline-thread'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Inline review test',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-review',
              role: 'user',
              content: 'Add a null check to the JSON parser.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'msg-assistant-review',
              role: 'assistant',
              content: 'Added the null guard and a regression test for empty input.',
              toolCalls: [],
              createdAt: now + 1,
            },
            {
              id: 'msg-user-followup',
              role: 'user',
              content: 'Thanks — that looks right.',
              toolCalls: [],
              createdAt: now + 2,
            },
          ],
          review: {
            status: 'done',
            summary:
              'Reviewed the change to `src/parser.ts`. The null guard is correct and the new test covers the empty-input case. No issues found.',
          },
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 2,
        },
      ],
    }),
    'utf8',
  )
}

export function seedSubagentFixture(workspaceRoot: string): void {
  const projectId = 'e2e-subagent-project'
  const threadId = 'e2e-subagent-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Subagent display test',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-subagent',
              role: 'assistant',
              content: 'Here is what the subagent found.',
              toolCalls: [
                {
                  id: 'tc-explore-1',
                  name: 'explore',
                  args: { query: 'Find README' },
                  status: 'done',
                  result: 'README describes Copse setup and dev workflow.',
                  subagent: {
                    id: 'sub-session-1',
                    kind: 'explore',
                    status: 'done',
                    prompt: 'Find README',
                    summary: 'README describes Copse setup and dev workflow.',
                    messages: [
                      {
                        id: 'sub-msg-1',
                        role: 'assistant',
                        content: 'Reading **README.md** for project overview.',
                        toolCalls: [
                          {
                            id: 'inner-read-1',
                            name: 'read_file',
                            args: { path: 'README.md' },
                            status: 'done',
                            result: '# Copse\n',
                          },
                        ],
                      },
                      {
                        id: 'sub-msg-2',
                        role: 'assistant',
                        content: 'README describes Copse setup and dev workflow.',
                        toolCalls: [],
                      },
                    ],
                  },
                },
              ],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** Thread with a completed CI investigator subagent tool card for visual validation. */
export function seedCiInvestigatorFixture(workspaceRoot: string): void {
  const projectId = 'e2e-ci-investigator-project'
  const threadId = 'e2e-ci-investigator-thread'
  const summary = [
    '**Failing check:** `CI / check`',
    '',
    '**Root cause:** `npm run typecheck` failed — `src/main/foo.ts:12` calls `bar()` with a missing argument.',
    '',
    '**Suggested fix:** pass the required `id` argument to `bar()` in `src/main/foo.ts`.',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'CI investigator display test',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-ci',
              role: 'assistant',
              content: 'I investigated the failing CI and found the root cause.',
              toolCalls: [
                {
                  id: 'tc-investigate-ci-1',
                  name: 'investigate_ci',
                  args: { pr_number: 42 },
                  status: 'done',
                  result: summary,
                  subagent: {
                    id: 'sub-ci-1',
                    kind: 'investigate_ci',
                    status: 'done',
                    prompt: 'Investigate CI failures for PR #42',
                    summary,
                    messages: [
                      {
                        id: 'sub-ci-msg-1',
                        role: 'assistant',
                        content: 'Reading the **failing run logs** for PR #42.',
                        toolCalls: [
                          {
                            id: 'inner-run-list-1',
                            name: 'gh_run_list',
                            args: { failed_only: true },
                            status: 'done',
                            result: '#1234 CI: FAILURE (feature @ abcdef1)',
                          },
                          {
                            id: 'inner-run-view-1',
                            name: 'gh_run_view',
                            args: { run_id: 1234 },
                            status: 'done',
                            result: 'src/main/foo.ts(12,3): error TS2554: Expected 1 argument.',
                          },
                        ],
                      },
                      {
                        id: 'sub-ci-msg-2',
                        role: 'assistant',
                        content: summary,
                        toolCalls: [],
                      },
                    ],
                  },
                },
              ],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

const GIT_CHANGES_FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/git-changes-repo')

function buildLargeStagedFile(value: number): string {
  const lines = [
    '// Copyright notice',
    '// Baseline module used by git changes e2e',
    '',
    'export const metadata = { version: 1, kind: "demo" }',
  ]
  for (let i = 1; i <= 25; i++) {
    lines.push(`export function helper${i}(): number { return ${i}; }`)
  }
  lines.push(`export const value = ${value}`)
  for (let i = 26; i <= 50; i++) {
    lines.push(`export function helper${i}(): number { return ${i}; }`)
  }
  return `${lines.join('\n')}\n`
}

function initGitChangesFixtureRepo(): void {
  const repoRoot = GIT_CHANGES_FIXTURE_ROOT
  mkdirSync(repoRoot, { recursive: true })
  rmSync(join(repoRoot, 'untracked.ts'), { force: true })
  writeFileSync(join(repoRoot, 'staged.ts'), buildLargeStagedFile(1), 'utf8')
  writeFileSync(join(repoRoot, 'unstaged.ts'), 'export const name = "old"\n', 'utf8')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'E2E')
  git('config', 'commit.gpgsign', 'false')
  git('add', '.')
  git('commit', '-q', '-m', 'baseline')
}

/** Reset the committed git-changes fixture to staged + unstaged + untracked state. */
export function resetGitChangesFixtureState(): void {
  const repoRoot = GIT_CHANGES_FIXTURE_ROOT
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })
  git('checkout', '-f', 'HEAD')
  git('clean', '-fd')
  writeFileSync(join(repoRoot, 'staged.ts'), buildLargeStagedFile(2), 'utf8')
  git('add', 'staged.ts')
  writeFileSync(join(repoRoot, 'unstaged.ts'), 'export const name = "new"\n', 'utf8')
  writeFileSync(join(repoRoot, 'untracked.ts'), 'export const fresh = true\n', 'utf8')
}

/**
 * Seeds the stable git-changes fixture as the active project. Returns the repo path.
 */
export function seedGitChangesFixture(): string {
  if (!existsSync(join(GIT_CHANGES_FIXTURE_ROOT, '.git'))) {
    initGitChangesFixtureRepo()
  }
  resetGitChangesFixtureState()
  const repoRoot = GIT_CHANGES_FIXTURE_ROOT
  const projectId = 'e2e-git-changes-project'
  const threadId = 'e2e-git-changes-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: repoRoot, name: 'git-workspace' }],
      activeProjectId: projectId,
      workspaceRoot: repoRoot,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Git changes test',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )

  writeSettings({})

  return repoRoot
}

export function cleanupGitChangesFixture(repoRoot: string): void {
  if (repoRoot === GIT_CHANGES_FIXTURE_ROOT) {
    resetGitChangesFixtureState()
    return
  }
  rmSync(repoRoot, { recursive: true, force: true })
}

const GIT_IMAGE_FIXTURES = join(process.cwd(), 'tests/e2e/fixtures')

/**
 * Git repo with staged/unstaged/untracked image changes for the Changes panel
 * image preview e2e. Returns the repo path for cleanup.
 */
export function seedGitImageChangesFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'copse-panel-git-img-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })

  git('init', '-q')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'E2E')
  git('config', 'commit.gpgsign', 'false')

  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-red.png'), join(repoRoot, 'staged.png'))
  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-blue.png'), join(repoRoot, 'unstaged.png'))
  git('add', '.')
  git('commit', '-q', '-m', 'baseline')

  // Staged: red → blue.
  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-blue.png'), join(repoRoot, 'staged.png'))
  git('add', 'staged.png')

  // Unstaged: blue → red.
  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-red.png'), join(repoRoot, 'unstaged.png'))

  // Untracked new image.
  copyFileSync(join(GIT_IMAGE_FIXTURES, 'git-changes-red.png'), join(repoRoot, 'new.png'))

  const projectId = 'e2e-git-image-changes-project'
  const threadId = 'e2e-git-image-changes-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: repoRoot, name: 'git-image-workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Git image changes test',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )

  return repoRoot
}

/** Long thread so the messages list overflows and scroll-to-bottom can be exercised. */
export function seedScrollToBottomFixture(workspaceRoot: string): void {
  const projectId = 'e2e-scroll-bottom-project'
  const threadId = 'e2e-scroll-bottom-thread'
  const messages = Array.from({ length: 24 }, (_, i) => {
    const isUser = i % 2 === 0
    const turn = Math.floor(i / 2) + 1
    return {
      id: `msg-scroll-${i}`,
      role: isUser ? 'user' : 'assistant',
      content: isUser
        ? `Question ${turn}: Can you explain part ${turn} of this feature in detail?`
        : `Answer ${turn}: Here is a detailed explanation for turn ${turn}. `.repeat(8),
      toolCalls: [],
      createdAt: Date.now() + i,
    }
  })

  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Scroll to bottom test',
          status: 'idle',
          messages,
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** One completed exchange plus a long history so scrolling up during streaming is meaningful. */
export function seedScrollStreamingFixture(workspaceRoot: string): void {
  const projectId = 'e2e-scroll-stream-project'
  const threadId = 'e2e-scroll-stream-thread'
  const history = Array.from({ length: 20 }, (_, i) => {
    const isUser = i % 2 === 0
    const turn = Math.floor(i / 2) + 1
    return {
      id: `msg-history-${i}`,
      role: isUser ? 'user' : 'assistant',
      content: isUser ? `Earlier question ${turn}` : `Earlier answer ${turn}: `.repeat(10),
      toolCalls: [],
      createdAt: Date.now() + i,
    }
  })
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Scroll while streaming',
          status: 'idle',
          messages: history,
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

export function seedTodoPlanFixtures(workspaceRoot: string): {
  planThreadTitle: string
  noPlanThreadTitle: string
} {
  const projectId = 'e2e-todo-project'
  const planThreadId = 'e2e-todo-thread'
  const noPlanThreadId = 'e2e-todo-no-plan-thread'
  const planThreadTitle = 'Todo display test'
  const noPlanThreadTitle = 'No plan thread'
  const todos = [
    { id: 'todo-1', content: 'Refactor renderer.ts fence extraction', status: 'completed' },
    { id: 'todo-2', content: 'Add mermaid lazy loader + post-render hook', status: 'in_progress' },
    {
      id: 'todo-3',
      content: 'Add CSS, unit tests, and e2e coverage',
      status: 'pending',
      assignedModel: 'local',
      check: { kind: 'typecheck' },
    },
    { id: 'todo-4', content: 'Run npm run check + build/e2e', status: 'pending' },
    { id: 'todo-5', content: 'Create GitHub issue for diagram steering', status: 'pending' },
  ]
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: planThreadId,
          title: planThreadTitle,
          status: 'idle',
          messages: [
            {
              id: 'msg-user-todo',
              role: 'user',
              content: 'Implement mermaid and open an issue for diagram steering.',
              toolCalls: [],
              createdAt: Date.now(),
            },
            {
              id: 'msg-assistant-todo',
              role: 'assistant',
              content: 'Working through the plan.',
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          todos,
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now() + 2,
          updatedAt: Date.now() + 2,
        },
        {
          id: noPlanThreadId,
          title: noPlanThreadTitle,
          status: 'idle',
          messages: [
            {
              id: 'msg-user-no-plan',
              role: 'user',
              content: 'What files are in src/?',
              toolCalls: [],
              createdAt: Date.now(),
            },
            {
              id: 'msg-assistant-no-plan',
              role: 'assistant',
              content: 'I can list the src directory for you.',
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now() + 1,
          updatedAt: Date.now() + 1,
        },
      ],
    }),
    'utf8',
  )
  return { planThreadTitle, noPlanThreadTitle }
}

/** @deprecated Use seedTodoPlanFixtures — kept for older specs that only need the plan thread. */
export function seedTodoDisplayFixture(workspaceRoot: string): void {
  seedTodoPlanFixtures(workspaceRoot)
}

/** Running thread with a queued follow-up message for edit / send-now e2e. */
export function seedQueuedMessageFixture(workspaceRoot: string): {
  threadId: string
  queuedMessageId: string
  queuedText: string
} {
  const projectId = 'e2e-queued-message-project'
  const threadId = 'e2e-queued-message-thread'
  const queuedMessageId = 'msg-user-queued'
  const queuedText = 'Then add unit tests for the parser.'
  const now = Date.now()
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Queued message edit',
          status: 'running',
          messages: [
            {
              id: 'msg-user-first',
              role: 'user',
              content: 'Refactor the JSON parser.',
              toolCalls: [],
              createdAt: now,
            },
            {
              id: 'msg-assistant-first',
              role: 'assistant',
              content: 'Working on the refactor now…',
              toolCalls: [],
              createdAt: now + 1,
            },
            {
              id: queuedMessageId,
              role: 'user',
              content: queuedText,
              toolCalls: [],
              createdAt: now + 2,
            },
          ],
          pendingMessages: [
            {
              messageId: queuedMessageId,
              payload: { content: queuedText, invokedSkills: [], priorTodos: [] },
              createdAt: now + 2,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now + 2,
        },
      ],
    }),
    'utf8',
  )
  return { threadId, queuedMessageId, queuedText }
}

export function seedToolDisplayFixture(workspaceRoot: string): void {
  const projectId = 'e2e-tool-display-project'
  const threadId = 'e2e-tool-display-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Tool display test',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-1',
              role: 'assistant',
              content: 'Here is what I found in the repo.',
              toolCalls: [
                {
                  id: 'tc-read-1',
                  name: 'read_file',
                  args: { path: 'README.md' },
                  status: 'done',
                  result: '# Copse\n',
                },
                {
                  id: 'tc-list-1',
                  name: 'list_dir',
                  args: { path: 'src' },
                  status: 'done',
                  result: 'd main\nf index.ts',
                },
                {
                  id: 'tc-read-2',
                  name: 'read_file',
                  args: { path: 'missing.txt' },
                  status: 'error',
                  result: 'Error: ENOENT',
                },
              ],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** Thread showing built-in browser tool cards (navigate/snapshot/screenshot/interact). */
export function seedBrowserToolsFixture(workspaceRoot: string): void {
  const projectId = 'e2e-browser-tools-project'
  const threadId = 'e2e-browser-tools-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Browser tools test',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-browser',
              role: 'user',
              content: 'Open the local dev server and check the heading renders.',
              toolCalls: [],
              createdAt: Date.now(),
            },
            {
              id: 'msg-assistant-browser',
              role: 'assistant',
              content:
                'Opened the page, read its accessibility snapshot, and captured a screenshot.',
              toolCalls: [
                {
                  id: 'tc-browser-navigate',
                  name: 'browser_navigate',
                  args: { url: 'http://localhost:3000/' },
                  status: 'done',
                  result: 'Opened tab-1: Computer Use Demo\nhttp://localhost:3000/',
                },
                {
                  id: 'tc-browser-snapshot',
                  name: 'browser_snapshot',
                  args: {},
                  status: 'done',
                  result:
                    'page: "Computer Use Demo"\nurl: http://localhost:3000/\n\n- heading "Welcome"\n- link "Docs" [ref=e1]\n- textbox "Search" [ref=e2]',
                },
                {
                  id: 'tc-browser-screenshot',
                  name: 'browser_screenshot',
                  args: {},
                  status: 'done',
                  result: 'Saved screenshot of tab-1 to /tmp/browser-screenshots/tab-1.png',
                },
              ],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** Explore subagent thread with search-routing markdown matching semantic-search UI. */
export function seedSemanticSearchExploreFixture(workspaceRoot: string): void {
  const projectId = 'e2e-semantic-search-project'
  const threadId = 'e2e-semantic-search-thread'
  const summary = [
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

  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'copse-panel' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Mechanism Explained',
          status: 'idle',
          messages: [
            {
              id: 'msg-user-1',
              role: 'user',
              content: 'is there semantic search',
              toolCalls: [],
              createdAt: Date.now(),
            },
            {
              id: 'msg-assistant-1',
              role: 'assistant',
              content:
                "Good find — there *is* semantic search, but it's not in the file path indexer. It's in the **agent's code search routing**. Let me explore it.",
              toolCalls: [
                {
                  id: 'tc-explore-semantic',
                  name: 'explore',
                  args: { query: 'How is semantic search routed?' },
                  status: 'done',
                  result: summary,
                  subagent: {
                    id: 'sub-semantic-1',
                    kind: 'explore',
                    status: 'done',
                    prompt: 'How is semantic search routed?',
                    summary,
                    messages: [
                      {
                        id: 'sub-msg-1',
                        role: 'assistant',
                        content: summary,
                        toolCalls: [
                          {
                            id: 'inner-read-1',
                            name: 'read_file',
                            args: { path: 'src/main/services/search-routing.ts' },
                            status: 'done',
                            result: 'export function classifySearchQuery() {}',
                          },
                          {
                            id: 'inner-search-1',
                            name: 'search_codebase',
                            args: { query: 'classifySearchQuery' },
                            status: 'done',
                            result: 'search-routing.ts:12',
                          },
                        ],
                      },
                      {
                        id: 'sub-msg-2',
                        role: 'assistant',
                        content:
                          'Let me find where this classification function is called and how semantic tools are passed in.',
                        toolCalls: [
                          {
                            id: 'inner-search-2',
                            name: 'search_codebase',
                            args: { query: 'semantic search routing' },
                            status: 'done',
                            result: 'agent-service.ts:88',
                          },
                          {
                            id: 'inner-read-2',
                            name: 'read_file',
                            args: { path: 'src/main/services/agent-service.ts' },
                            status: 'done',
                            result: 'const route = classifySearchQuery(query)',
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

export interface FooterBranchSeedIds {
  projectId: string
  matchThreadId: string
  mismatchThreadId: string
  currentBranch: string
  mismatchBranch: string
}

/** Used thread plus a blank composer for draft-prompt preservation e2e. */
export function seedDraftPromptFixture(workspaceRoot: string): {
  usedThreadTitle: string
  blankThreadTitle: string
} {
  const projectId = 'e2e-draft-prompt-project'
  const usedThreadId = 'e2e-draft-used'
  const blankThreadId = 'e2e-draft-blank'
  const usedThreadTitle = 'Used thread'
  const blankThreadTitle = 'New Thread'
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: blankThreadId,
          title: blankThreadTitle,
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now + 1,
          updatedAt: now + 1,
        },
        {
          id: usedThreadId,
          title: usedThreadTitle,
          status: 'idle',
          messages: [
            {
              id: 'msg-user-used',
              role: 'user',
              content: 'hello from used thread',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    'utf8',
  )

  return { usedThreadTitle, blankThreadTitle }
}

/** Two threads bound to different branches for footer branch / mismatch screenshots. */
export function seedFooterBranchFixture(workspaceRoot: string): FooterBranchSeedIds {
  const projectId = 'e2e-footer-branch-project'
  const matchThreadId = 'e2e-footer-branch-match'
  const mismatchThreadId = 'e2e-footer-branch-mismatch'
  const currentBranch = e2eGitBranch()
  const mismatchBranch = currentBranch === 'main' ? 'feature-branch' : 'main'
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: matchThreadId,
          title: 'Matching branch',
          status: 'idle',
          gitBranch: currentBranch,
          messages: [
            {
              id: 'msg-user-match',
              role: 'user',
              content: 'Thread on the checked-out branch.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 1200, outputTokens: 400 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: mismatchThreadId,
          title: 'Other branch',
          status: 'idle',
          gitBranch: mismatchBranch,
          messages: [
            {
              id: 'msg-user-mismatch',
              role: 'user',
              content: 'Thread started on a different branch.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 800, outputTokens: 200 },
          createdAt: now,
          updatedAt: now,
        },
      ],
      activeThreadId: matchThreadId,
    }),
    'utf8',
  )

  return {
    projectId,
    matchThreadId,
    mismatchThreadId,
    currentBranch,
    mismatchBranch,
  }
}

/** Blank new-thread composer for footer branch picker screenshots. */
export function seedFooterBranchPickerFixture(workspaceRoot: string): {
  projectId: string
  blankThreadId: string
  currentBranch: string
} {
  const projectId = 'e2e-footer-branch-picker-project'
  const blankThreadId = 'e2e-footer-branch-picker-blank'
  const currentBranch = e2eGitBranch()
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: blankThreadId,
          title: 'New Thread',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
      activeThreadId: blankThreadId,
    }),
    'utf8',
  )

  return { projectId, blankThreadId, currentBranch }
}

/** Single thread bound to a branch that differs from HEAD (mismatch footer screenshot). */
export function seedFooterBranchMismatchFixture(workspaceRoot: string): FooterBranchSeedIds {
  const projectId = 'e2e-footer-branch-project'
  const matchThreadId = 'e2e-footer-branch-match'
  const mismatchThreadId = 'e2e-footer-branch-mismatch'
  const currentBranch = e2eGitBranch()
  const mismatchBranch = currentBranch === 'main' ? 'feature-branch' : 'main'
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: mismatchThreadId,
          title: 'Other branch',
          status: 'idle',
          gitBranch: mismatchBranch,
          messages: [
            {
              id: 'msg-user-mismatch',
              role: 'user',
              content: 'Thread started on a different branch.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 800, outputTokens: 200 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
    'utf8',
  )

  return {
    projectId,
    matchThreadId,
    mismatchThreadId,
    currentBranch,
    mismatchBranch,
  }
}

export function seedComposerBranchWarningFixture(workspaceRoot: string): {
  projectId: string
  threadId: string
  mismatchBranch: string
} {
  const projectId = 'e2e-composer-branch-warning-project'
  const threadId = 'e2e-composer-branch-warning-thread'
  const mismatchBranch = 'feature/thread-branch'
  const now = Date.now()

  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Thread branch warning',
          status: 'idle',
          gitBranch: mismatchBranch,
          messages: [
            {
              id: 'msg-user-branch-warning',
              role: 'user',
              content: 'Continue this branch.',
              toolCalls: [],
              createdAt: now,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
      activeThreadId: threadId,
    }),
    'utf8',
  )

  return { projectId, threadId, mismatchBranch }
}

/** Table with glob paths in inline code + architecture list (Repo Core Files repro). */
export function seedMarkdownBoldGlobFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-bold-glob-project'
  const threadId = 'e2e-markdown-bold-glob-thread'
  const content = [
    '## Tests',
    '',
    '| Path | Role |',
    '| --- | --- |',
    '| **`src/**/*.test.ts`** | Unit tests (bundled by esbuild into `dist-test/`) |',
    '| **`tests/e2e/`** | WebdriverIO e2e tests (tool display, markdown rendering, etc.) |',
    '| **`tests/fixtures/`** | E2E test fixtures |',
    '',
    '## Key Supporting Files',
    '',
    '- **`README.md`** — Project overview, commands, layout',
    '- **`AGENTS.md`** — Detailed agent instructions: running headless, mock LLM, permission policy',
    '- **`vendor/`** — Bundled `codesearch` binary (downloaded on `npm install`)',
    '',
    '## Architecture Notes',
    '',
    '- **No backend** — main process talks directly to LLM providers',
    '- **Persistence** via `electron-store` (JSON config under `~/Library/Application Support/copse-panel/` on macOS)',
    '- **LLM fallback**: `MockLLMProvider` when no API keys are set',
    '- **Shell permissions**: `src/main/services/permission-policy.ts` — macOS-only sandbox; other platforms use static analysis',
    '- **MCP host**: connects to MCP servers via `.cursor/mcp.json` or `~/.cursor/mcp.json`',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Repo core files overview',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-bold-glob',
              role: 'assistant',
              content,
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** PR-style draft table with narrow index/status columns and long branch names. */
export function seedMarkdownTableWrapFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-table-wrap-project'
  const threadId = 'e2e-markdown-table-wrap-thread'
  const content = [
    '### Draft (work in progress)',
    '',
    '| # | Title | Branch | Status |',
    '| --- | --- | --- | --- |',
    '| 296 | Screenshot validate: capture before/after tool-display grouping UI fix | `jkt/auto/queued-message-screenshot-eval-b2d1` | DRAFT |',
    '| 294 | Fix markdown table column wrapping in chat messages | `jkt/auto/markdown-table-wrapping-8760` | DRAFT |',
    '| 293 | Queued message composer badge polish | `jkt/auto/queued-message-badge` | DRAFT |',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Open draft PRs',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-table-wrap',
              role: 'assistant',
              content,
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}

/** 3-column table whose first column is a lone code span (e.g. a test name).
 * Regression for the first column shattering one character per line. */
export function seedMarkdownTableCodeFirstColumnFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-table-code-first-project'
  const threadId = 'e2e-markdown-table-code-first-thread'
  const content = [
    '### Remaining failures:',
    '',
    '| Test | Status | Reason |',
    '| --- | --- | --- |',
    '| `terminateProcessTree` | ❌ | Environment issue (process tree killing does not work in this test environment) |',
    '| `renderMarkdown` | ❌ | 3 subtests fail — the heading-level assertions in `renderer.test.ts` |',
    '| `sanitizeRenderedMarkdown` | ❌ | 1 subtest fails — the "is a no-op" test expects `<h2>` tags to survive sanitization |',
  ].join('\n')
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Remaining failures',
          status: 'idle',
          messages: [
            {
              id: 'msg-assistant-table-code-first',
              role: 'assistant',
              content,
              toolCalls: [],
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
}
