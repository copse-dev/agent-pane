import { mkdir } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { $, browser } from '@wdio/globals'
import { writeSeedConfig } from './helpers/seed-config.ts'
import { copseUserDataDir } from '../../src/main/services/storage/copse-paths.ts'

/**
 * Whether the agent is not running and no prompts remain queued.
 *
 * Exported as a predicate, not just as {@link waitForAgentIdle}, because a
 * caller may need to do work on every poll — the agent-eval drive dismisses
 * approval dialogs, which can appear at any point in a turn.
 */
export async function agentIsIdle(): Promise<boolean> {
  const stopBtn = await $('.stop-btn')
  const stopVisible = (await stopBtn.isExisting()) && (await stopBtn.getProperty('hidden')) !== true
  if (stopVisible) return false

  const queue = await $('.footer-queue')
  if (await queue.isExisting()) {
    const queueHidden = await queue.getProperty('hidden')
    if (queueHidden !== true) return false
  }

  return true
}

/** Wait until the agent is not running and no prompts remain queued. */
export async function waitForAgentIdle(timeoutMs = 15_000): Promise<void> {
  await browser.waitUntil(agentIsIdle, {
    timeout: timeoutMs,
    interval: 100,
    timeoutMsg: 'Agent did not return to idle',
  })
}

/**
 * Wait until the selected thread has been auto-named.
 *
 * `maybeNameThread` (renderer/controller/thread-naming.ts) fires when the agent
 * first responds and resolves the title through an IPC round trip, so a
 * screenshot taken as soon as the turn settles may show "New Thread" on one
 * run and the suggested title on the next. Call this before capturing a frame
 * that includes the sidebar for a thread the spec created by sending a message.
 */
export async function waitForActiveThreadTitle(timeoutMs = 15_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const title = await browser.execute(
        () => document.querySelector('.chat-row.selected .chat-title')?.textContent?.trim() ?? '',
      )
      return title !== '' && title !== 'New Thread'
    },
    {
      timeout: timeoutMs,
      interval: 100,
      timeoutMsg: 'the selected thread was never auto-named',
    },
  )
}

/** Composer is always enabled; wait until it is mounted. */
export async function waitForPromptReady(timeoutMs = 15_000): Promise<void> {
  await $('.prompt-input').waitForExist({ timeout: timeoutMs })
}

/** The single profile root `app-init.ts` puts Electron user data under. */
export function getCopseUserDataDir(): string {
  return copseUserDataDir()
}

export async function seedProjectConfig(
  workspaceRoot: string,
  options?: { projectId?: string; threadId?: string },
): Promise<void> {
  const configDir = getCopseUserDataDir()
  await mkdir(configDir, { recursive: true })

  const projectId = options?.projectId ?? 'e2e-project'
  const threadId = options?.threadId ?? 'e2e-thread'

  // Routes the seeded thread into the filesystem-native store (issue #644) and
  // writes the remaining fields to config.json.
  writeSeedConfig({
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
  })
}
