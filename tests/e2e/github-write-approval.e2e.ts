import { execFileSync } from 'node:child_process'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { submitComposer } from './helpers/composer.ts'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

// Keep mutating GitHub approval in the runtime gate; #1680 records the former
// quarantine and the evidence required for reinstatement.
describe('GitHub write approval', () => {
  before(async () => {
    resetUserData()
    const root = seedStableWorkspace()
    // `gh_pr_create` omits owner/repo to mean "current workspace repository" —
    // an origin remote lets the dialog resolve the real target instead of a
    // placeholder (see the `gh_pr_create` test below).
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], {
      cwd: root,
      stdio: 'pipe',
    })
    seedEmptyProject(root, 'e2e-github-write-approval-project', {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows a human question and PR target instead of snake_case + JSON', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await prepareMockToolTurn(
      'Mark pull request 1478 ready for review.',
      { name: 'gh_pr_mark_ready', args: { number: 1478 } },
      'The readiness request was declined; the pull request remains unchanged.',
    )
    await submitComposer()

    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText(
      'Mark pull request ready for review on GitHub?',
    )
    await expect(dialog.$('.approval-github-brand')).toBeDisplayed()
    await expect(dialog.$('.approval-github-brand')).toHaveText('GitHub')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toBe('PR #1478')
    expect(body).not.toContain('{')
    expect(body).not.toContain('gh_pr_mark_ready')

    await expect(dialog.$('.approval-approve')).toHaveElementClass('ui-btn-primary')
    await expect(dialog.$('.approval-reject')).toHaveElementClass('ui-btn-secondary')

    await saveElementScreenshot('#approval-dialog', 'github-write-approval-dialog.png')
    await saveAppScreenshot('github-write-approval.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle()
  })

  it('prompts before gh_pr_create opens a pull request, resolving the repo and rendering markdown', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await prepareMockToolTurn(
      'Create a pull request titled Fix the parser.',
      {
        name: 'gh_pr_create',
        args: {
          title: 'Fix the parser',
          body: '## Summary\n\n- Resolves the parser crash on empty input\n- Adds a regression test',
        },
      },
      'The pull request request was declined; no pull request was created.',
    )
    await submitComposer()

    const dialog = await $('#approval-dialog').getElement()
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Open pull request on GitHub?')

    const body = await dialog.$('.approval-body').getText()
    // Owner/repo were omitted from the tool call, meaning "current workspace
    // repository" — the dialog must resolve the real target, not a placeholder.
    expect(body).toContain('Repository: acme/widgets')
    expect(body).not.toContain('(current owner)')
    expect(body).not.toContain('(current repository)')
    expect(body).toContain('Title: Fix the parser')
    expect(body).toContain('Head: current branch (will be pushed)')
    expect(body).toContain('Base: repository default branch')
    await expect(dialog.$('.approval-advice')).toHaveText(expect.stringContaining('publishes'))
    await expect(dialog.$('.approval-approve')).toHaveText('Publish pull request')
    expect(body).not.toContain('gh_pr_create')

    // The PR description renders as real markdown — a heading and a list —
    // instead of literal `#`/`-` characters, inside the same scroll box.
    const markdown = dialog.$('.approval-body-markdown')
    await expect(markdown).toExist()
    await expect(markdown.$('h2')).toHaveText('Summary')
    const items = await markdown.$$('li')
    expect(items.length).toBe(2)
    await expect(items[0]).toHaveText(expect.stringContaining('Resolves the parser crash'))

    await saveElementScreenshot('#approval-dialog', 'github-write-approval-create-dialog.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
    await waitForAgentIdle()
  })
})
