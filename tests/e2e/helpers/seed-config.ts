import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

export function seedEmptyProject(
  workspaceRoot: string,
  projectId: string,
  options?: {
    subagentsEnabled?: boolean
    mockFollowUps?: boolean
    model?: string
    lmStudioUrl?: string
    lmStudioModel?: string
    lmStudioSubagentModel?: string
    lmStudioForSubagents?: boolean
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
  if (options?.lmStudioUrl) {
    settings.lmStudioUrl = options.lmStudioUrl
  }
  if (options?.lmStudioModel) {
    settings.lmStudioModel = options.lmStudioModel
  }
  if (options?.lmStudioSubagentModel) {
    settings.lmStudioSubagentModel = options.lmStudioSubagentModel
  }
  if (options?.lmStudioForSubagents !== undefined) {
    settings.lmStudioForSubagents = options.lmStudioForSubagents
  }
  if (Object.keys(settings).length > 0) {
    writeSettings(settings)
  } else {
    writeSettings({})
  }
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

export function seedTodoDisplayFixture(workspaceRoot: string): void {
  const projectId = 'e2e-todo-project'
  const threadId = 'e2e-todo-thread'
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
          id: threadId,
          title: 'Todo display test',
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
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }),
    'utf8',
  )
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
  const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  }).trim()
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

/** Single thread bound to a branch that differs from HEAD (mismatch footer screenshot). */
export function seedFooterBranchMismatchFixture(workspaceRoot: string): FooterBranchSeedIds {
  const projectId = 'e2e-footer-branch-project'
  const matchThreadId = 'e2e-footer-branch-match'
  const mismatchThreadId = 'e2e-footer-branch-mismatch'
  const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  }).trim()
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
