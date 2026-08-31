import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { describeSkipInCi } from './helpers/ci-gate.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

// Quarantined in CI by #1680: the Electron session dies mid-spec on the
// self-hosted runner (`invalid session id`, then `unknown command:
// 'Browser.getWindowForTarget'`) rather than failing an assertion. It
// reproduces on a `main`-based branch whose entire diff is two unrelated
// specs, so it is a runner fault and not something any PR changed — and while
// it is red, fail-fast hides every other shard on PRs without `ci-full`.
//
// **This is a healthy spec; reinstating it is a fix, not a cleanup.** It still
// runs locally — only the CI gate skips it. #1680 holds the evidence,
// including the shard sitting on its 6 GiB cgroup ceiling
// (`memory.events max=10736`) with `oom_kill=0`.
describeSkipInCi('GitHub write approval', () => {
  before(async () => {
    // The e2e availability probe deliberately keeps real `gh` disabled. Seed a
    // dummy API token so the write tools are registered, while MOCK_GH keeps
    // every operation on the in-memory backend.
    writeE2eEnv({ GITHUB_TOKEN: 'e2e-token' })
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-github-write-approval-project', {
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

    await setComposerValue('[[mcp:gh_pr_mark_ready {"number":1478}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Mark pull request ready for review?')

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
  })

  it('prompts before gh_pr_create opens a pull request, showing the PR title', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await setComposerValue('[[mcp:gh_pr_create {"title":"Fix the parser"}]]')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })

    await expect(dialog.$('.approval-heading')).toHaveText('Open pull request on GitHub?')

    const body = await dialog.$('.approval-body').getText()
    expect(body).toBe('“Fix the parser”')
    expect(body).not.toContain('gh_pr_create')

    await saveElementScreenshot('#approval-dialog', 'github-write-approval-create-dialog.png')

    await dialog.$('.approval-reject').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
  })
})
