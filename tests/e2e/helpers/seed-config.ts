import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
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
    'The lint is already clean — no issues to fix. Here is the summary:',
    '',
    '- **Tests:** All 110 tests pass.',
    '- **Lint:** `npm run lint` (which runs `eslint .`) exits with code 0 and reports zero errors or warnings.',
    '- `npx eslint . --max-warnings 0`: Also exits cleanly with no violations.',
    '',
    'There are no lint errors in this codebase — ESLint is configured and passing.',
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
                        content: 'Reading README.md for project overview.',
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
