import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { prepareMockTurn } from './helpers/mock-scenario.ts'
import { saveAppViewportScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

describe('Changes chip includes committed branch work', () => {
  let temporaryRoot = ''
  let root = ''
  let previousMockBranch: string | undefined

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  }

  before(async () => {
    previousMockBranch = process.env['COPSE_PANEL_MOCK_BRANCH']
    resetUserData()
    temporaryRoot = mkdtempSync(join(tmpdir(), 'copse-committed-chip-'))
    root = join(temporaryRoot, 'committed-chip')
    mkdirSync(root)
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
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: '' })
    await browser.reloadSession()
  })

  after(() => {
    writeE2eEnv({ COPSE_PANEL_MOCK_BRANCH: previousMockBranch })
    resetUserData()
    if (temporaryRoot) removeE2eTree(temporaryRoot)
  })

  it('keeps accurate totals as edits move from the working tree into commits', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // This turn reviews existing feature work; choose its base through the real picker.
    await $('.branch-picker-trigger').click()
    await $('.branch-picker-filter').setValue('feature')
    const feature = $('.branch-picker-option')
    await feature.waitForDisplayed({ timeout: 10_000 })
    await expect(feature.$('.branch-picker-option-label')).toHaveText('feature')
    await feature.click()
    await expect($('.branch-picker-label')).toHaveText('feature')
    assert.equal(git('branch', '--show-current'), 'feature')
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
    // Linux sandbox workers briefly materialize protected paths as mount
    // points. Keep the clean-checkout assertion, but allow their cleanup to
    // finish before inspecting the app's committed-change view.
    await browser.waitUntil(() => git('status', '--porcelain') === '', {
      timeout: 15_000,
      timeoutMsg: 'expected the checkout to be clean after commit and sandbox worker cleanup',
    })
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
    let stableCapture = false
    for (let attempt = 0; attempt < 3 && !stableCapture; attempt += 1) {
      await saveAppViewportScreenshot('changes-chip-committed.png', async () => {
        // A clean frame can precede the pane's 500ms watcher debounce. Require
        // the committed row to stay settled beyond it, after capture framing.
        // Viewport capture avoids element screenshot resizing after this wait.
        let settledSince = 0
        await browser
          .waitUntil(
            async () => {
              const settled = await browser.execute(() => {
                const list = document.querySelector('#git-changes-host .git-changes-list')
                return (
                  list?.querySelector('.git-change-row-committed .git-change-path')?.textContent ===
                    'example.txt' &&
                  !list.querySelector('.pane-loading') &&
                  !list.textContent.includes('Checking committed changes')
                )
              })
              if (!settled) {
                settledSince = 0
                return false
              }
              settledSince ||= Date.now()
              return Date.now() - settledSince >= 750
            },
            {
              timeout: 15_000,
              interval: 100,
              timeoutMsg:
                'expected committed changes to remain settled beyond the watcher debounce',
            },
          )
          .catch(async (error: unknown) => {
            const snapshot = await browser.execute(() => {
              const host = document.querySelector('#git-changes-host')
              const list = host?.querySelector('.git-changes-list')
              return {
                hostPresent: Boolean(host),
                listPresent: Boolean(list),
                paths: [...(list?.querySelectorAll('.git-change-path') ?? [])].map(
                  (path) => path.textContent,
                ),
                pending: [...(list?.querySelectorAll('.pane-loading') ?? [])].map(
                  (row) => row.textContent,
                ),
                text: list?.textContent,
              }
            })
            throw new Error(`Changes capture readiness failed: ${JSON.stringify(snapshot)}`, {
              cause: error,
            })
          })
        // Readiness checks before and after a screenshot can both miss a
        // refresh that starts and finishes during ChromeDriver's capture.
        // Observe the real list throughout capture; never hide its loading UI.
        await browser.execute(() => {
          const host = document.getElementById('git-changes-host')
          if (!host) throw new Error('Changes host missing before capture')
          host.dataset['captureChanged'] = 'false'
          const observer = new MutationObserver(() => {
            host.dataset['captureChanged'] = 'true'
          })
          observer.observe(host, { childList: true, subtree: true, characterData: true })
          document.addEventListener(
            'e2e-changes-capture-finished',
            () => {
              observer.disconnect()
            },
            {
              once: true,
            },
          )
        })
      })
      stableCapture = await browser.execute(() => {
        document.dispatchEvent(new Event('e2e-changes-capture-finished'))
        const host = document.getElementById('git-changes-host')
        const stable = host?.dataset['captureChanged'] === 'false'
        if (host) delete host.dataset['captureChanged']
        return stable
      })
    }
    assert.ok(stableCapture, 'expected Changes to remain unchanged throughout screenshot capture')
    assert.doesNotMatch(
      await $('#git-changes-host .git-changes-list').getText(),
      /Checking committed changes/,
    )
  })
})
