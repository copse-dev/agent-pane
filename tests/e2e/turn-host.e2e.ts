import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { copseUserDataDir } from '../../src/main/services/storage/copse-paths.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
} from './helpers/seed-config.ts'

/**
 * With Settings → Experimental → "Run turns in a background host" on, every
 * turn runs in the resident turn host rather than the app's main process
 * (`docs/plans/local-turn-worker.md`, "Every turn in a turn host"). The app is
 * a view of the host's turns: it can crash mid-turn and the turn still finishes,
 * once, and a prompt the host turn raises is answered in the window as an
 * in-process turn's would be.
 *
 * Scripted scenarios reach the host too (`turn-host-test-scenarios.ts`), so a
 * hold set before the crash is released after the relaunch.
 */
const PROJECT_ID = 'e2e-turn-host-project'
const CRASH_PROMPT = 'Check the build and report what remains.'
const CRASH_REPLY = 'The build is complete; nothing remains.'
const APPROVAL_PROMPT = 'Run the check script.'
const APPROVAL_COMMAND = 'echo host-approval-ok'
const APPROVAL_REPLY = 'The check printed host-approval-ok.'

function metaPath(threadId: string): string {
  return join(e2eWorkspaceDir(), PROJECT_ID, threadId, 'meta.json')
}

function threadStatus(threadId: string): string | null {
  const path = metaPath(threadId)
  if (!existsSync(path)) return null
  return /"status"\s*:\s*"(\w+)"/.exec(readFileSync(path, 'utf8'))?.[1] ?? null
}

/** The pids of the hosts this spec's profile started, from the host's log. */
function hostPids(): number[] {
  const path = join(copseUserDataDir(), 'logs', 'turn-host.log')
  if (!existsSync(path)) return []
  return [...readFileSync(path, 'utf8').matchAll(/pid (\d+)\)/g)].map((match) => Number(match[1]))
}

function stopHosts(): void {
  for (const pid of hostPids()) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

async function selectedThreadId(): Promise<string> {
  const row = await $('.chat-row.selected').getElement()
  await row.waitForExist({ timeout: 30_000 })
  const threadId = await row.getAttribute('data-thread-id')
  assert.ok(threadId, 'a thread is selected')
  return threadId
}

describe('turns in the background host', function () {
  this.timeout(180_000)

  beforeEach(async () => {
    stopHosts()
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), PROJECT_ID, {
      model: 'claude-sonnet-4-6',
      subagentsEnabled: false,
      // Every shell command asks, sandbox or not, so the approval is deterministic.
      autoRunSandboxCommands: false,
      turnsRunInHost: true,
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
  })

  // The suite's own after-test check reads each scenario's status, which the
  // host holds after a relaunch, so the host is stopped only once that is done.
  after(() => {
    stopHosts()
    resetUserData()
  })

  it('finishes a turn once after the app crashed mid-turn, with no Retry card', async () => {
    const threadId = await selectedThreadId()
    const scenario = await installMockScenario({
      title: 'Build check held across a crash',
      turns: [
        {
          user: CRASH_PROMPT,
          responses: [{ waitFor: 'after-crash', text: CRASH_REPLY }],
        },
      ],
    })
    await setComposerValue(CRASH_PROMPT)
    await submitComposer()
    await scenario.waitForHold('after-crash')
    assert.ok(hostPids().length > 0, 'the turn runs in a host')
    await browser.waitUntil(() => threadStatus(threadId) === 'running', {
      timeout: 10_000,
      timeoutMsg: 'the running status was not written before the crash',
    })

    // A crash, not a quit: kill main outright. The host, in its own process
    // group, holds the turn at the scripted hold.
    const mainPid = await browser.execute(
      async () =>
        (await window.api.processManager.snapshot()).processes.find((row) => row.type === 'App')
          ?.pid ?? null,
    )
    assert.ok(mainPid !== null && mainPid > 1)
    process.kill(mainPid, 'SIGKILL')
    await browser.reloadSession()
    await $(`.chat-row[data-thread-id="${threadId}"]`).waitForExist({ timeout: 60_000 })
    await $(`.chat-row[data-thread-id="${threadId}"]`).click()

    // The relaunched app follows the host's turn; releasing the hold lets it
    // finish where it ran.
    await scenario.release('after-crash')
    await scenario.waitForComplete(30_000)
    await browser.waitUntil(() => threadStatus(threadId) === 'idle', {
      timeout: 30_000,
      timeoutMsg: 'the host turn did not finish',
    })
    await expectAssistantReply(CRASH_REPLY)

    // Once: the prompt, one reply, no continuation note and no Retry card.
    const users = await $$('.messages-list .msg-user .message-text').map((node) => node.getText())
    expect(users.map((text) => text.trim())).toEqual([CRASH_PROMPT])
    await expect($('.msg-user.msg-machine-origin')).not.toExist()
    await expect($('[data-turn-recovery-card]')).not.toExist()
    const replies = await $$('.msg-assistant .message-text').map((node) => node.getText())
    expect(replies.filter((text) => text.includes(CRASH_REPLY))).toHaveLength(1)
  })

  it("answers a host turn's approval in the window", async () => {
    const threadId = await selectedThreadId()
    const scenario = await installMockScenario({
      title: 'Host turn asks to run a command',
      turns: [
        {
          user: APPROVAL_PROMPT,
          responses: [
            { toolCalls: [{ name: 'run_shell', args: { command: APPROVAL_COMMAND } }] },
            {
              expectToolResults: [{ name: 'run_shell', includes: 'host-approval-ok' }],
              text: APPROVAL_REPLY,
            },
          ],
        },
      ],
    })
    await setComposerValue(APPROVAL_PROMPT)
    await submitComposer()
    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })
    // Where no OS sandbox runs (a bare container), the same prompt asks to run unsandboxed.
    await expect(dialog.$('.approval-heading')).toHaveText(
      /^Run (shell command|without sandbox)\?$/,
    )
    assert.ok(hostPids().length > 0, 'the turn runs in a host')
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await scenario.waitForComplete(30_000)
    await expectAssistantReply(APPROVAL_REPLY)
    // The window follows the host's turn to its end, not just to its reply.
    await browser.waitUntil(() => threadStatus(threadId) === 'idle', {
      timeout: 30_000,
      timeoutMsg: 'the host turn did not finish',
    })
    await $('.stop-btn').waitForDisplayed({ reverse: true, timeout: 15_000 })
  })
})
