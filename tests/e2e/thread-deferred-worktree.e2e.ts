import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  readSeededSettings,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { waitForAgentIdle, waitForPromptReady } from './helpers.ts'
import { startConversationServer, type ConversationServer } from './helpers/conversation-server.ts'
import {
  prepareE2eScreenshot,
  saveAppScreenshot,
  savePreparedAppScreenshot,
} from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-deferred-worktree-project'
const THREAD_ID = 'e2e-deferred-worktree-abc123'
const AGENT_BRANCH = 'copse/readme-usage-abc123'
const ORIGINAL_README = 'deferred worktree fixture\n'
const EDITED_README = 'deferred worktree fixture\n\n## Usage\n\nRun it.\n'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Submit and wait for the turn's final reply. `waitForAgentIdle` alone can
 * pass before the stop button first appears, which would let the assertions
 * below run against a turn that has not started (or not finished its tools).
 */
async function sendAndAwaitReply(prompt: string, reply: string): Promise<void> {
  await setComposerValue(prompt)
  await $('.submit-btn').click()
  await browser.waitUntil(
    async () =>
      (
        await browser.execute(
          () =>
            [...document.querySelectorAll<HTMLElement>('.msg-assistant')].at(-1)?.innerText ?? '',
        )
      ).includes(reply),
    { timeout: 60_000, interval: 100, timeoutMsg: `No reply containing "${reply}"` },
  )
  await waitForAgentIdle()
}

/**
 * An `on-write` project: the thread reads the user's checkout until its agent
 * needs to write, and only then gets a worktree and branch.
 */
describe('deferred thread worktree', () => {
  let projectRoot = ''
  let worktreeRoot = ''
  let server: ConversationServer

  before(async function () {
    this.timeout(120_000)
    // Let the worker's first window finish loading before the session is
    // replaced; closing it mid-load hangs the renderer on this spec's timing.
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === 'complete',
    )
    server = await startConversationServer({ title: 'Readme Usage' })
    // Assert the real Git branch rather than the screenshot harness's fixed one.
    server.configureEnvironment({ COPSE_PANEL_MOCK_BRANCH: '' })
    resetUserData()
    const worktreesRoot = process.env['COPSE_WORKTREES_DIR']
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-deferred-worktree-'))
    worktreeRoot = join(worktreesRoot, PROJECT_ID, THREAD_ID)
    rmSync(worktreeRoot, { recursive: true, force: true })
    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    writeFileSync(join(projectRoot, 'README.md'), ORIGINAL_README)
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])

    seedEmptyProject(projectRoot, PROJECT_ID, {
      subagentsEnabled: false,
      nextStepSuggestionEnabled: false,
    })
    writeSettings({ ...readSeededSettings(), ...server.settings })
    const now = Date.now()
    writeSeedConfig({
      projects: [
        { id: PROJECT_ID, path: projectRoot, name: 'workspace', worktreeMode: 'on-write' },
      ],
      activeProjectId: PROJECT_ID,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_ID,
          title: 'New Thread',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(async () => {
    try {
      server.assertComplete()
    } finally {
      resetUserData()
      if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true })
      if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
      await server.close()
    }
  })

  it('answers a question from the user checkout without creating a worktree', async function () {
    this.timeout(120_000)
    await waitForPromptReady()
    const prompt = 'What does the README say?'
    const reply = 'The README introduces the deferred worktree fixture.'
    server.enqueue(
      { user: prompt, toolCalls: [{ name: 'read_file', args: { path: 'README.md' } }] },
      {
        user: prompt,
        toolResults: [{ name: 'read_file', includes: 'deferred worktree fixture' }],
        text: reply,
      },
    )
    await sendAndAwaitReply(prompt, reply)

    await expect($('.footer-branch-status .footer-branch-label')).toHaveText('main')
    assert.equal(existsSync(worktreeRoot), false, 'a question must not allocate a worktree')
    assert.equal(git(projectRoot, ['branch', '--list', 'copse/*']), '', 'nor create a branch')
    await saveAppScreenshot('thread-deferred-worktree-reading.png')
  })

  it('creates the worktree when the agent asks to write, and edits only there', async function () {
    this.timeout(120_000)
    const prompt = 'Add a usage section to the README.'
    const reply = 'Added a usage section on its own branch.'
    server.enqueue(
      {
        user: prompt,
        toolCalls: [{ name: 'request_write_access', args: { branch_name: 'readme usage' } }],
      },
      {
        user: prompt,
        // The model is told where it now works, not just that it may write.
        toolResults: [{ name: 'request_write_access', includes: 'own worktree' }],
        toolCalls: [{ name: 'write_file', args: { path: 'README.md', content: EDITED_README } }],
      },
      {
        user: prompt,
        toolResults: [{ name: 'write_file' }],
        text: reply,
      },
    )
    await sendAndAwaitReply(prompt, reply)

    await expect($('.footer-branch-status .footer-branch-label')).toHaveText(AGENT_BRANCH, {
      wait: 30_000,
    })
    // Successful tool activity renders collapsed, and getText() reads only
    // rendered text, so read names from the DOM whether or not a group is open.
    const toolNames = await browser.execute(() =>
      [...document.querySelectorAll('.tool-card .tool-name')].map((name) => name.textContent),
    )
    assert.ok(toolNames.includes('Created worktree'), `tool cards: ${toolNames.join(', ')}`)

    assert.equal(git(worktreeRoot, ['branch', '--show-current']), AGENT_BRANCH)
    assert.equal(readFileSync(join(worktreeRoot, 'README.md'), 'utf8'), EDITED_README)
    // The user's checkout is exactly as it was.
    assert.equal(readFileSync(join(projectRoot, 'README.md'), 'utf8'), ORIGINAL_README)
    assert.equal(git(projectRoot, ['branch', '--show-current']), 'main')
    assert.equal(git(projectRoot, ['status', '--porcelain']), '')
    // Size the frame before positioning the card. `saveAppScreenshot` normally
    // does this itself, but that resize scrolls the transcript back to the
    // bottom and can move the evidence out of the captured viewport.
    await prepareE2eScreenshot()
    // Show the switch in the frame: open the run's collapsed tool group and
    // centre the allocation card inside the conversation scrollport.
    await browser.execute(() => {
      const name = [...document.querySelectorAll('.tool-card .tool-name')].find(
        (node) => node.textContent === 'Created worktree',
      )
      for (let node = name?.parentElement; node; node = node.parentElement) {
        if (node instanceof HTMLDetailsElement) node.open = true
      }
      name?.closest('.tool-card')?.scrollIntoView({ block: 'center', inline: 'nearest' })
    })
    const visibleInFrame = await browser.execute(() => {
      const name = [...document.querySelectorAll<HTMLElement>('.tool-card .tool-name')].find(
        (node) => node.textContent === 'Created worktree',
      )
      const frame = document.querySelector<HTMLElement>('.conversation-scroll')
      if (!name || !frame || name.getClientRects().length === 0) return false
      const card = name.closest<HTMLElement>('.tool-card') ?? name
      const cardRect = card.getBoundingClientRect()
      const frameRect = frame.getBoundingClientRect()
      return cardRect.top >= frameRect.top && cardRect.bottom <= frameRect.bottom
    })
    assert.equal(
      visibleInFrame,
      true,
      'the Created worktree card should be inside the captured conversation frame',
    )
    await savePreparedAppScreenshot('thread-deferred-worktree-writing.png')
  })
})
