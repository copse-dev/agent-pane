import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig, writeSettings } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

const projectId = 'e2e-changes-project'
const threadId = 'e2e-changes-thread'
let root = ''
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' })

async function summary() {
  return browser.execute(
    async (projectId, threadId) => {
      return window.api.git.threadChangeSummary([{ projectId, threadId }], { fresh: true })
    },
    projectId,
    threadId,
  )
}

describe('native sidebar thread changes', () => {
  before(async function () {
    this.timeout(120_000)
    root = mkdtempSync(join(tmpdir(), 'copse-native-changes-'))
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.test')
    writeFileSync(join(root, 'README.md'), 'Changes fixture\n')
    git('add', '.')
    git('commit', '-qm', 'Initial')
    writeFileSync(join(root, 'pending.txt'), 'Uncommitted work\n')
    resetUserData()
    const now = Date.now()
    writeSeedConfig({
      projects: [{ id: projectId, name: 'changes-fixture', path: root }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
      activeThreadId: threadId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Review uncommitted work',
          status: 'idle',
          messages: [
            { id: 'changes-user', role: 'user', content: 'Prepare the change', createdAt: now },
            {
              id: 'changes-answer',
              role: 'assistant',
              content: 'The change is ready for review.',
              createdAt: now + 1,
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
    writeSettings({ theme: 'dark' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('reads real Git through IPC and displays the dirty glyph without changing the checkout', async function () {
    this.timeout(90_000)
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
    expect(await summary()).toEqual([{ dirty: true }])
    await $('.chat-changes-status').waitForExist({ timeout: 15_000 })
    await expect($('.chat-changes-status')).toHaveAttribute('aria-label', 'Uncommitted changes')
    const before = git('status', '--porcelain')
    expect(await summary()).toEqual([{ dirty: true }])
    expect(git('status', '--porcelain')).toBe(before)
    await saveAppScreenshot('sidebar-thread-changes-native.png')
    git('add', '.')
    git('commit', '-qm', 'Save pending work')
    expect(await summary()).toEqual([{ dirty: false }])
    await $('.chat-changes-status').waitForExist({ timeout: 30_000, reverse: true })
    await saveAppScreenshot('sidebar-thread-changes-native-clean.png')
  })
})
