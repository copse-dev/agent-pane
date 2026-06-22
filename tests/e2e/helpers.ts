import { mkdir, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'

/** Wait until the agent is not running and no prompts remain queued. */
export async function waitForAgentIdle(timeoutMs = 15_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const stopBtn = await $('.stop-btn')
      const stopVisible =
        (await stopBtn.isExisting()) && (await stopBtn.getProperty('hidden')) !== true
      if (stopVisible) return false

      const queue = await $('.footer-queue')
      if (await queue.isExisting()) {
        const queueHidden = await queue.getProperty('hidden')
        if (queueHidden !== true) return false
      }

      return true
    },
    { timeout: timeoutMs, interval: 100, timeoutMsg: 'Agent did not return to idle' },
  )
}

/** Composer is always enabled; wait until it is mounted. */
export async function waitForPromptReady(timeoutMs = 15_000): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: timeoutMs })
}

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
