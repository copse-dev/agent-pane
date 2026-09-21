import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'

const PROJECT_ID = 'e2e-thread-switch-isolated-project'
const THREAD_A = 'e2e-thread-switch-isolated-a'
const THREAD_B = 'e2e-thread-switch-isolated-b'
// The mock provider caps one delay directive at 5s. Its existing reasoning
// directive adds another ~5s before A's first tool call, leaving enough overlap
// for a loaded runner to allocate B's checkout.
const HOLDING_REASONING =
  'Holding the first checkout open while the second isolated thread starts. '.repeat(8)

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function runningThreadIds(): Promise<string[]> {
  return browser.execute(async () => window.api.agent.runningThreadIds())
}

async function loadedThreadHistory(projectId: string): Promise<
  Array<{
    id: string
    worktreePath: string | null
    messages: Array<{
      role: string
      content: string
      toolResults: Array<{ name: string; result: string | null }>
    }>
  }>
> {
  return browser.execute(async (id) => {
    const threads = await window.api.threads.loadProject(id)
    return Promise.all(
      threads.map(async (thread) => {
        const messages = await window.api.threads.loadMessages(id, thread.id)
        return {
          id: thread.id,
          worktreePath: thread.worktree?.path ?? null,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
            toolResults: message.toolCalls.map((toolCall) => ({
              name: toolCall.name,
              result: toolCall.result,
            })),
          })),
        }
      }),
    )
  }, projectId)
}

describe('switching between isolated running threads', () => {
  let projectRoot = ''
  let worktreesRoot = ''
  let threadAWorktree = ''
  let threadBWorktree = ''

  before(async function () {
    this.timeout(120_000)
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    resetUserData()

    worktreesRoot = process.env['COPSE_WORKTREES_DIR'] ?? ''
    if (!worktreesRoot) throw new Error('COPSE_WORKTREES_DIR is not configured for e2e')
    projectRoot = mkdtempSync(join(tmpdir(), 'copse-thread-switch-'))
    threadAWorktree = join(worktreesRoot, PROJECT_ID, THREAD_A)
    threadBWorktree = join(worktreesRoot, PROJECT_ID, THREAD_B)
    rmSync(join(worktreesRoot, PROJECT_ID), { recursive: true, force: true })

    git(projectRoot, ['init', '-q', '-b', 'main'])
    git(projectRoot, ['config', 'user.email', 'e2e@example.invalid'])
    git(projectRoot, ['config', 'user.name', 'Copse E2E'])
    git(projectRoot, ['config', 'init.defaultBranch', 'main'])
    git(projectRoot, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(projectRoot, 'README.md'), 'thread switch isolation fixture\n', 'utf8')
    git(projectRoot, ['add', 'README.md'])
    git(projectRoot, ['commit', '-qm', 'seed'])
    if (
      realpathSync(git(projectRoot, ['rev-parse', '--show-toplevel'])) !== realpathSync(projectRoot)
    ) {
      throw new Error('fixture repository did not resolve to its own temporary root')
    }

    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: PROJECT_ID, path: projectRoot, name: 'workspace', worktreeMode: 'always' }],
      activeProjectId: PROJECT_ID,
      expandedProjectId: PROJECT_ID,
      activeThreadId: THREAD_A,
      [`threads:${PROJECT_ID}`]: [
        {
          id: THREAD_A,
          title: 'Thread A — isolated run',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: THREAD_B,
          title: 'Thread B — isolated run',
          draftPrompt: 'B pending prompt',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now + 1,
          updatedAt: now + 1,
        },
      ],
    })

    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    for (const path of [threadAWorktree, threadBWorktree]) {
      if (projectRoot && existsSync(path)) {
        try {
          git(projectRoot, ['worktree', 'remove', '--force', path])
        } catch {
          // The app may already have retired the checkout after the test.
        }
      }
    }
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    delete process.env['COPSE_PANEL_MOCK_LLM']
    delete process.env['ANTHROPIC_API_KEY']
    delete process.env['OPENAI_API_KEY']
  })

  it('keeps thread A running and persisted when switching to thread B', async function () {
    this.timeout(150_000)

    const aRow = $(`.chat-row[data-thread-id="${THREAD_A}"]`)
    const bRow = $(`.chat-row[data-thread-id="${THREAD_B}"]`)
    await aRow.waitForDisplayed({ timeout: 15_000 })
    await bRow.waitForDisplayed({ timeout: 15_000 })

    // The delay keeps A in its real provider turn while the second checkout is
    // selected. The directive also makes the first turn leave a real tool result
    // in A's history, rather than proving this only with a canned text reply.
    await setComposerValue(
      `A checkout probe [[mcp:list_dir {"path":"."}]] [[mock:delay_ms 5000]] [[mock:reasoning ${HOLDING_REASONING}]]`,
    )
    await $('.submit-btn').click()
    await browser.waitUntil(
      async () => aRow.getAttribute('class').then((value) => value.includes('is-running')),
      {
        timeout: 15_000,
        timeoutMsg: 'thread A did not enter a running state',
      },
    )
    await browser.waitUntil(() => existsSync(threadAWorktree), {
      timeout: 30_000,
      timeoutMsg: 'thread A did not receive its isolated checkout',
    })
    writeFileSync(join(threadAWorktree, 'thread-a-marker.txt'), 'A checkout marker\n', 'utf8')
    await browser.waitUntil(async () => (await runningThreadIds()).includes(THREAD_A), {
      timeout: 10_000,
      timeoutMsg: 'thread A was not present in the main-process run registry',
    })

    await bRow.click()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', THREAD_B)

    // Switching the active thread must leave A in the main-process run registry.
    await expect(await runningThreadIds()).toContain(THREAD_A)

    await setComposerValue(
      `B checkout probe [[mcp:list_dir {"path":"."}]] [[mock:delay_ms 5000]] [[mock:reasoning ${HOLDING_REASONING}]]`,
    )
    await $('.submit-btn').click()
    await browser.waitUntil(async () => (await runningThreadIds()).includes(THREAD_B), {
      timeout: 15_000,
      timeoutMsg: 'thread B did not enter a running state after switching threads',
    })
    await browser.waitUntil(() => existsSync(threadBWorktree), {
      timeout: 30_000,
      timeoutMsg: 'thread B did not receive its isolated checkout',
    })
    writeFileSync(join(threadBWorktree, 'thread-b-marker.txt'), 'B checkout marker\n', 'utf8')
    await expect(await runningThreadIds()).toEqual(expect.arrayContaining([THREAD_A, THREAD_B]))

    await browser.waitUntil(async () => (await runningThreadIds()).length === 0, {
      timeout: 45_000,
      timeoutMsg: 'both isolated runs did not settle',
    })

    const history = await loadedThreadHistory(PROJECT_ID)
    const savedA = history.find((thread) => thread.id === THREAD_A)
    const savedB = history.find((thread) => thread.id === THREAD_B)
    if (!savedA || !savedB) throw new Error('expected both isolated thread histories to load')
    await expect(savedA.worktreePath).toBe(threadAWorktree)
    await expect(savedB.worktreePath).toBe(threadBWorktree)
    await expect(realpathSync(threadAWorktree)).not.toBe(realpathSync(threadBWorktree))
    await expect(savedA.messages.some((message) => message.role === 'assistant')).toBe(true)
    await expect(savedB.messages.some((message) => message.role === 'assistant')).toBe(true)
    const aListResults = savedA.messages.flatMap((message) =>
      message.toolResults
        .filter((tool) => tool.name === 'list_dir')
        .map((tool) => tool.result ?? ''),
    )
    const bListResults = savedB.messages.flatMap((message) =>
      message.toolResults
        .filter((tool) => tool.name === 'list_dir')
        .map((tool) => tool.result ?? ''),
    )
    await expect(aListResults.some((result) => result.includes('thread-a-marker.txt'))).toBe(true)
    await expect(aListResults.some((result) => result.includes('thread-b-marker.txt'))).toBe(false)
    await expect(bListResults.some((result) => result.includes('thread-b-marker.txt'))).toBe(true)
    await expect(bListResults.some((result) => result.includes('thread-a-marker.txt'))).toBe(false)
    await expect(savedA.messages.map((message) => message.content).join('\n')).toContain(
      'Mock response to: A checkout probe',
    )
    await expect(savedB.messages.map((message) => message.content).join('\n')).toContain(
      'Mock response to: B checkout probe',
    )

    // Reload from the filesystem-native thread store and select A again. This
    // proves the completion was persisted to A, not only retained in memory
    // while B was active.
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $(`.chat-row[data-thread-id="${THREAD_A}"]`).click()
    await expect($('.chat-row.selected')).toHaveAttribute('data-thread-id', THREAD_A)
    await expect($('.messages-list')).toHaveText(
      expect.stringContaining('Mock response to: A checkout probe'),
    )
    await saveElementScreenshot('.messages-list', 'thread-switch-isolated-worktrees.png')
  })
})
