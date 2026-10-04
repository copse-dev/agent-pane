import { mkdirSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import {
  resetUserData,
  seedE2eThreePaneLayout,
  seedE2eViewport,
  seedPrPanelChatFixture,
} from './helpers/seed-config.ts'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { isDisplayFace, readHeadingStyle } from './helpers/heading-style.ts'

describe('PR panel (mock gh)', () => {
  before(async function () {
    this.timeout(120_000)
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({ COPSE_PANEL_MOCK_GH: '1', COPSE_PANEL_MOCK_GH_STATUS: 'ready' })
    resetUserData()
    seedPrPanelChatFixture(process.cwd())
    seedE2eViewport()
    seedE2eThreePaneLayout()
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 }).getElement()
  })

  after(() => {
    resetUserData()
  })

  async function openPrTab(): Promise<void> {
    const pane = await $('#pane-files').getElement().getElement()
    if (!(await pane.isDisplayed())) {
      await $('.titlebar-panel-controls .titlebar-btn[aria-label="Toggle right panel"]').click().getElement()
      await pane.waitForDisplayed({ timeout: 10_000 })
    }
    await $('[aria-label="Open pull requests"]').click().getElement()
    await browser.pause(800)
  }

  it('captures mock PR panel screenshots and DOM assertions', async function () {
    this.timeout(120_000)

    await openPrTab()

    // Default view = chat-linked + workspace rows only; the cross-repo "your
    // PRs" section stays collapsed (and unqueried) until expanded.
    await browser.waitUntil(async () => (await $$('.pr-list-row').getElements().getElements()).length >= 2, {
      timeout: 15_000,
      timeoutMsg: 'expected linked and workspace PR rows',
    })

    await expect(await $('.git-changes-section-title*=Related PRs').getElement()).toHaveText(
      expect.stringMatching(/related PRs · this thread \(1\)/i),
    )
    // Repo-scoped header drops the "In " prefix to save horizontal space.
    await expect(await $('.git-changes-section-title*=copse-panel').getElement().getElement()).toHaveText(
      expect.stringMatching(/^copse-dev\/copse-panel \(1\)$/i),
    )
    await expect(
      await $('.pr-list-row[data-pr-section="linked"] .pr-list-title').getElement().getElement(),
    ).toHaveText('Add GitHub PR panel tab')
    // Match the repo-scoped row by its title rather than a data-pr-section
    // selector so the oracle doesn't extract a generic "workspace" token that
    // would falsely couple backend files to this spec.
    await expect(
      await $('.pr-list-title*=Tidy up workspace status polling').getElement().getElement(),
    ).toBeDisplayed()

    // Issue #2482: a free-text filter narrows the visible groups. The workspace
    // PR's branch name hides the now-empty "From chat" group entirely, leaving
    // only the matching row.
    const filterInput = await $('.pr-pane-filter').getElement().getElement()
    await expect(filterInput).toHaveAttribute('placeholder', 'Filter pull requests')
    await filterInput.click()
    await filterInput.setValue('chore/workspace-status')
    await browser.waitUntil(async () => (await $$('.pr-list-row').getElements().getElements()).length === 1, {
      timeout: 10_000,
      timeoutMsg: 'expected the filter to narrow to a single matching row',
    })
    await expect(await $('.pr-list-title*=Tidy up workspace status polling').getElement()).toBeDisplayed()
    await expect(await $('.git-changes-section-title*=Related PRs').getElement()).not.toBeExisting()
    await saveElementScreenshot('#pane-files', 'pr-panel-filter-match.png')

    // A query matching nothing shows the empty state instead of any group.
    await filterInput.setValue('zzz-nonexistent-pr-999')
    await browser.waitUntil(
      async () =>
        /no pull requests match/i.test(await (await $('.pr-list-body').getElement().getElement()).getText()),
      { timeout: 10_000, timeoutMsg: 'expected the no-matches empty state' },
    )
    await expect(await $$('.pr-list-row').getElements().getElements()).toBeElementsArrayOfSize(0)
    await saveElementScreenshot('#pane-files', 'pr-panel-filter-empty.png')

    // Escape clears the filter and restores every group, keeping focus on the
    // input, so the rest of this test continues against the unfiltered list.
    await browser.keys('Escape')
    await expect(filterInput).toHaveValue('')
    await browser.waitUntil(async () => (await $$('.pr-list-row').getElements().getElements()).length >= 2, {
      timeout: 10_000,
      timeoutMsg: 'expected rows to return after clearing the filter',
    })
    await expect(filterInput).toBeFocused()

    // Use the thread panel's glyph and failure marker in PR rows too.
    await expect(await $('.pr-list-status.is-open.has-ci-failure').getElement()).toBeDisplayed()
    await expect(await $('.pr-list-row[data-pr-section="linked"] .pr-list-status').getElement()).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/#42 open; CI passing/i),
    )
    await expect(await $('.pr-list-status svg[data-icon="git-pull-request"]').getElement()).toBeDisplayed()

    // The cross-repo section is a collapsed, countless toggle by default; its
    // PR (#17) hasn't been loaded.
    const otherToggle = await $('.pr-other-toggle').getElement().getElement()
    await expect(otherToggle).toHaveText(expect.stringMatching(/your other open prs/i))
    await expect(otherToggle).not.toHaveText(expect.stringMatching(/\(\d+\)/))
    await expect(
      await $('.pr-list-title*=Polish footer branch status').getElement().getElement(),
    ).not.toBeExisting()

    // Expanding loads the cross-repo list and its lazily-fetched CI state.
    await otherToggle.click()
    await expect(await $('.pr-list-title*=Polish footer branch status').getElement()).toBeDisplayed()
    await expect(await $('.pr-list-status[aria-label="PR #17 open; CI running"]').getElement()).toBeDisplayed()

    // The expanded group uses the same single, readable filter-aware empty
    // state even when every loaded cross-repo PR is filtered out. The component
    // test covers the zero-loaded-PR edge case from the Copse review.
    await filterInput.setValue('zzz-nonexistent-pr-999')
    await browser.waitUntil(
      async () =>
        /no pull requests match/i.test(await (await $('.pr-list-body').getElement().getElement()).getText()),
      { timeout: 10_000, timeoutMsg: 'expected the expanded no-matches empty state' },
    )
    await expect(await $$('.pr-list-row').getElements().getElements()).toBeElementsArrayOfSize(0)
    await expect(
      await $$('.git-changes-empty*=No pull requests match').getElements().getElements(),
    ).toBeElementsArrayOfSize(1)
    await saveElementScreenshot('#pane-files', 'pr-panel-filter-empty-expanded.png')
    await browser.keys('Escape')
    await expect(
      await $('.pr-list-title*=Polish footer branch status').getElement().getElement(),
    ).toBeDisplayed()

    await browser.waitUntil(
      async () => {
        const title = await $('.pr-viewer-title').getElement().getElement()
        return (
          (await title.isDisplayed()) && (await title.getText()).includes('Add GitHub PR panel tab')
        )
      },
      { timeout: 15_000, timeoutMsg: 'expected auto-selected mock PR viewer' },
    )

    // The PR title is a utility heading in a dense pane, not a page masthead:
    // Pliant 600 rather than the h1–h3 display face.
    const viewerTitle = await readHeadingStyle('.pr-viewer-title')
    expect(viewerTitle).not.toBeNull()
    if (!viewerTitle) throw new Error('Missing fixture measurement: viewerTitle')
    expect(viewerTitle.tag).toBe('H4')
    expect(isDisplayFace(viewerTitle.family)).toBe(false)
    expect(viewerTitle.weight).toBe('600')

    await saveElementScreenshot('#pane-files', 'pr-panel-linked-list.png')
    await expect(await $('.pr-viewer-description').getElement().getElement()).toHaveText(
      expect.stringContaining('PRs'),
    )
    await expect(await $('.pr-viewer-description').getElement().getElement()).not.toHaveText(
      expect.stringMatching(/template hint|<!--|Copse PR template/i),
    )

    // Overview uses the full body; Files is a separate destination.
    await expect(await $('.pr-viewer-files').getElement()).not.toBeDisplayed()
    await expect(await $('.pr-viewer-description-fill').getElement()).toBeDisplayed()
    await expect(await $('#pr-viewer-host .panel-empty').getElement()).not.toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-panel-viewer.png')
    await $('.pr-detail-section[data-section="files"]').click().getElement()
    await expect(await $('.pr-viewer-description').getElement()).not.toBeDisplayed()
    await expect(await $('.pr-files-header').getElement()).toHaveText(
      expect.stringMatching(/changed files \(4\)/i),
    )
    await expect(await $$('.pr-file-row').getElements()).toBeElementsArrayOfSize(4)
    await browser.execute(() => {
      const row = [...document.querySelectorAll<HTMLButtonElement>('.pr-file-row')].find(
        (candidate) => candidate.textContent.includes('pr-pane.ts'),
      )
      row?.click()
    })
    await (await $('.pr-file-row.is-selected').getElement().getElement()).waitForDisplayed({ timeout: 10_000 })
    await (
      await $('#pr-viewer-host .git-diff-editor-wrap').getElement().getElement()
    ).waitForDisplayed({ timeout: 15_000 })
    await expect(await $('.pr-viewer-description-fill').getElement().getElement()).not.toBeExisting()
    await saveElementScreenshot('#pane-files', 'pr-panel-viewer-file-diff.png')

    // Binary images bypass Monaco and render the PR's base/head blobs side by
    // side. This is the path that previously decoded PNG bytes as UTF-8 text.
    await $('.pr-list-title*=Polish footer branch status').click().getElement()
    await expect(await $('.pr-viewer-title').getElement()).toHaveText('Polish footer branch status')
    await $('.pr-detail-section[data-section="files"]').click().getElement()
    await expect(await $('.pr-files-header').getElement()).toHaveText(
      expect.stringMatching(/changed files \(2\)/i),
    )
    await expect(await $$('.pr-file-row').getElements()).toBeElementsArrayOfSize(2)
    await browser.execute(() => {
      const row = [...document.querySelectorAll<HTMLButtonElement>('.pr-file-row')].find(
        (candidate) => candidate.textContent.includes('pr-panel.png'),
      )
      row?.click()
    })
    const imageDiff = await $('#pr-viewer-host .git-image-diff').getElement().getElement()
    await imageDiff.waitForDisplayed({ timeout: 15_000 })
    await expect(
      await $$('#pr-viewer-host .git-image-diff-img').getElements().getElements(),
    ).toBeElementsArrayOfSize(2)
    const labels = await $$('#pr-viewer-host .git-image-diff-label').map((label).getElements() => label.getText())
    expect(labels).toEqual(['BEFORE', 'AFTER'])
    await expect(await $('#pr-viewer-host .monaco-diff-editor').getElement().getElement()).not.toBeDisplayed()
    await saveElementScreenshot('#pane-files', 'pr-panel-viewer-image-diff.png')

    await $('[aria-label="Toggle right panel"]').click().getElement()
    await browser.pause(200)
    await (
      await $('[data-message-id="msg-assistant-pr-link"] .message-text a').getElement().getElement()
    ).click()
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () =>
            document.querySelector('[aria-label="Open pull requests"].active') != null &&
            document.querySelector('.pr-viewer-title')?.textContent === 'Add GitHub PR panel tab',
        ),
      { timeout: 10_000, timeoutMsg: 'expected chat PR link to open mock PR viewer' },
    )

    await $('[aria-label="Settings"]').click().getElement()
    await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 }).getElement()
    // #1448 moved the GitHub CLI fieldset out of General into Agent. Only the
    // active section is shown, so without this the fieldset below is in a
    // hidden section and `.gh-cli-status` reads as empty.
    await $('.settings-nav-btn[data-section="agent"]').click().getElement()
    await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.settings-content')
      const fieldset = [...document.querySelectorAll<HTMLFieldSetElement>('fieldset')].find(
        (candidate) => candidate.querySelector('legend')?.textContent.trim() === 'GitHub CLI',
      )
      if (!content || !fieldset) return
      content.scrollTop = Math.max(0, fieldset.offsetTop - 24)
    })
    await browser.pause(200)
    await expect(await $('.gh-cli-status').getElement().getElement()).toHaveText(
      expect.stringMatching(/signed in as @mock-user/i),
    )
    // The GitHub backend selector (gh CLI vs API) lives in the same fieldset.
    const backendSelect = await $('.gh-backend-field select[name="githubBackend"]').getElement().getElement()
    await expect(backendSelect).toBeDisplayed()
    await expect(await backendSelect.$$('option').getElements().getElements()).toBeElementsArrayOfSize(3)
    await saveElementScreenshot('#settings-dialog', 'pr-panel-settings-gh-cli.png')
    await $('.settings-close-btn').click().getElement()
  })
})
