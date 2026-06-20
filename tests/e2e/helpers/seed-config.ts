import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Mirrors `app.setPath('userData', …)` in `src/main/app-init.ts`. */
function copsePanelUserDataDir(): string {
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
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings), 'utf8')
}

export function seedEmptyProject(
  workspaceRoot: string,
  projectId: string,
  options?: { subagentsEnabled?: boolean; mockFollowUps?: boolean },
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
  if (Object.keys(settings).length > 0) {
    writeSettings(settings)
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

/**
 * Creates a throwaway git repo with a committed baseline plus a staged
 * modification, an unstaged modification, and an untracked file, then seeds it
 * as the active project. Returns the repo path so the spec can clean it up.
 */
export function seedGitChangesFixture(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'copse-panel-git-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' })

  git('init', '-q')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'E2E')
  git('config', 'commit.gpgsign', 'false')

  writeFileSync(join(repoRoot, 'staged.ts'), 'export const value = 1\n', 'utf8')
  writeFileSync(join(repoRoot, 'unstaged.ts'), 'export const name = "old"\n', 'utf8')
  git('add', '.')
  git('commit', '-q', '-m', 'baseline')

  // Staged modification.
  writeFileSync(join(repoRoot, 'staged.ts'), 'export const value = 2\n', 'utf8')
  git('add', 'staged.ts')

  // Unstaged modification to a tracked file.
  writeFileSync(join(repoRoot, 'unstaged.ts'), 'export const name = "new"\n', 'utf8')

  // Untracked file.
  writeFileSync(join(repoRoot, 'untracked.ts'), 'export const fresh = true\n', 'utf8')

  const projectId = 'e2e-git-changes-project'
  const threadId = 'e2e-git-changes-thread'
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      projects: [{ id: projectId, path: repoRoot, name: 'git-workspace' }],
      activeProjectId: projectId,
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

  return repoRoot
}

export function cleanupGitChangesFixture(repoRoot: string): void {
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
