import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/** Matches app-init.ts: join(app.getPath('appData'), 'copse-panel') */
export function getCopseUserDataDir(): string {
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
