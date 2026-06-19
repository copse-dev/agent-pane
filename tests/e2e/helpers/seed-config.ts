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

export function resetUserData(): void {
  rmSync(CONFIG_PATH, { force: true })
}

export function seedEmptyProject(workspaceRoot: string, projectId: string): void {
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
