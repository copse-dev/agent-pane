import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Mirrors `app.setPath('userData', …)` in `src/main/app-init.ts`. */
function agentPaneUserDataDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'agent-pane')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'agent-pane')
  }
  return join(homedir(), '.config', 'agent-pane')
}

const USER_DATA = agentPaneUserDataDir()
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
  options?: { subagentsEnabled?: boolean },
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
  if (options?.subagentsEnabled !== undefined) {
    writeSettings({ subagentsEnabled: options.subagentsEnabled })
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
    '- Mock LLM — `AGENT-WINDOW-MOCK-LLM=1` enables full e2e testing without API keys',
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
                  result: 'README describes agent-pane setup and dev workflow.',
                  subagent: {
                    id: 'sub-session-1',
                    kind: 'explore',
                    status: 'done',
                    prompt: 'Find README',
                    summary: 'README describes agent-pane setup and dev workflow.',
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
                            result: '# Agent Pane\n',
                          },
                        ],
                      },
                      {
                        id: 'sub-msg-2',
                        role: 'assistant',
                        content: 'README describes agent-pane setup and dev workflow.',
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
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-pane-git-'))
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
                  result: '# Agent Pane\n',
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
