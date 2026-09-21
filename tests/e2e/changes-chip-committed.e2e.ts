import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareMockTurn } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

describe('Changes chip includes committed branch work', () => {
  let root = ''

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  }

  before(async () => {
    resetUserData()
    root = mkdtempSync(join(tmpdir(), 'copse-committed-chip-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'E2E')
    git('config', 'user.email', 'e2e@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'init.defaultBranch', 'main')
    writeFileSync(join(root, 'example.txt'), 'before\n')
    git('add', '.')
    git('commit', '-qm', 'Baseline')
    git('checkout', '-qb', 'feature')
    writeFileSync(join(root, 'example.txt'), 'one\ntwo\n')
    git('commit', '-qam', 'Committed branch work')
    assert.equal(git('status', '--porcelain'), '')
    seedEmptyProject(root, 'e2e-committed-chip', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('keeps accurate totals as edits move from the working tree into commits', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await prepareMockTurn('Review the committed change.', [
      { text: 'The committed change replaces one line with two in example.txt.' },
    ])
    await $('.submit-btn').click()
    await waitForAgentIdle(20_000)

    await $('.follow-up-bubble-changes').waitForDisplayed({ timeout: 30_000 })
    await expect($('.follow-up-bubble-changes .follow-up-stat-add')).toHaveText('+2')
    await expect($('.follow-up-bubble-changes .follow-up-stat-del')).toHaveText('-1')

    writeFileSync(join(root, 'example.txt'), 'one\ntwo\nthree\n')
    await expect($('.follow-up-bubble-changes .follow-up-stat-add')).toHaveText('+3')
    git('commit', '-qam', 'Commit remaining edit')
    assert.equal(git('status', '--porcelain'), '')

    // The commit's watcher notification replaces this live follow-up row. A
    // WebDriver handle captured before committing no longer names a DOM node.
    // Retry only detachment during the click, with a fresh real element lookup.
    await browser.waitUntil(
      async () => {
        try {
          await $('.follow-up-bubble-changes').click()
          return true
        } catch (error) {
          if (error instanceof Error && /stale element/i.test(error.message)) return false
          throw error
        }
      },
      {
        timeout: 10_000,
        timeoutMsg: 'expected the live Changes chip to remain clickable after commit',
      },
    )
    await $('.git-change-row-committed').waitForDisplayed({ timeout: 15_000 })
    await expect($('.git-change-row-committed .git-change-path')).toHaveText('example.txt')
    await expect($('.follow-up-bubble-changes .follow-up-stat-add')).toHaveText('+3')
    await expect($('.follow-up-bubble-changes .follow-up-stat-del')).toHaveText('-1')
    await saveAppScreenshot('changes-chip-committed.png')
  })
})
