import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/** Matches `app.setPath('userData', …)` in `src/main/app-init.ts`. */
export function getCopseUserDataDir(): string {
  const override = process.env.COPSE_PANEL_USER_DATA?.trim()
  if (override) return override
  const home = homedir()
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'copse-panel')
  }
  return join(home, '.config', 'copse-panel')
}

export async function seedProjectConfig(
  workspaceRoot: string,
  options?: { projectId?: string; threadId?: string },
): Promise<void> {
  const configDir = getCopseUserDataDir()
  await mkdir(configDir, { recursive: true })

  const projectId = options?.projectId ?? 'e2e-project'
  const threadId = options?.threadId ?? 'e2e-thread'

  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify(
      {
        projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
        activeProjectId: projectId,
        workspaceRoot,
        [`threads:${projectId}`]: [
          {
            id: threadId,
            title: 'E2E thread',
            status: 'idle',
            messages: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      },
      null,
      2,
    ),
  )
}
