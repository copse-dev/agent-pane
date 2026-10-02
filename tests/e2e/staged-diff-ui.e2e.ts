import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { collectErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

const PROJECT_ID = 'e2e-staged-diff-project'
// Without git, file writes take the supported proposed-diff path. Keep this
// fixture outside the source checkout so accepted edits cannot pollute it.
let workspaceRoot = ''

async function writeProposedFile(
  title: string,
  user: string,
  path: string,
  content: string,
  reply: string,
): Promise<void> {
  const scenario = await installMockScenario({
    title,
    turns: [
      {
        user,
        responses: [
          { toolCalls: [{ name: 'write_file', args: { path, content } }] },
          { text: reply, expectToolResults: [{ name: 'write_file' }] },
        ],
      },
    ],
  })
  await setComposerValue(user)
  await $('.submit-btn').click()
  await waitForAgentIdle(60_000)
  await expectAssistantReply(reply)
  await scenario.assertComplete()
}

describe('staged diff approval UI', () => {
  before(async function () {
    this.timeout(120_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-staged-diff-'))
    resetUserData()
    seedEmptyProject(workspaceRoot, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
  })

  after(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
    resetUserData()
  })

  it('stages diffs in the Changes panel with single- and multi-file selection', async function () {
    this.timeout(120_000)
    await $('.prompt-input').waitForExist({ timeout: 30_000 })

    await writeProposedFile(
      'Propose the first staged TypeScript file',
      'Create src/e2e-staged-a.ts with a constant named a set to 1.',
      'src/e2e-staged-a.ts',
      'export const a = 1\n',
      'I prepared the proposed change for src/e2e-staged-a.ts.',
    )

    await browser.waitUntil(
      async () =>
        await $('.tool-card[data-status="done"], .tool-card[data-status="running"]').isExisting(),
      { timeout: 30_000, timeoutMsg: 'expected write_file tool card' },
    )

    await expect($('.titlebar-btn[aria-label="Open changes"]')).toHaveElementClass('active')
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 30_000 })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })

    const acceptBtn = await $('#git-diff-viewer-host .diff-accept-btn')
    const rejectBtn = await $('#git-diff-viewer-host .diff-reject-btn')
    await acceptBtn.waitForDisplayed({ timeout: 5_000 })
    await browser.waitUntil(async () => (await acceptBtn.getText()) === 'Accept', {
      timeout: 5_000,
    })
    await expect(rejectBtn).toHaveText('Reject')
    await expect($('.git-changes-bulk-actions')).not.toBeDisplayed()

    // Accept/Reject live in a bar below the editor; floating copies used to
    // cover the last diff lines and the editor's right-edge chrome (#1702).
    await expect($('#git-diff-viewer-host .diff-approval-bar')).toBeDisplayed()
    const editorRect = await browser.execute(() => {
      const editor = document.querySelector('#git-diff-viewer-host .monaco-diff-editor')
      if (!editor) return null
      const { top, bottom } = editor.getBoundingClientRect()
      return { top, bottom }
    })
    const acceptRect = await browser.execute(() => {
      const btn = document.querySelector('#git-diff-viewer-host .diff-accept-btn')
      if (!btn) return null
      const { top, bottom } = btn.getBoundingClientRect()
      return { top, bottom }
    })
    if (!editorRect || !acceptRect) throw new Error('missing diff editor or accept button rect')
    await expect(acceptRect.top >= editorRect.bottom).toBe(true)

    // Accept/Reject are yes/no chrome, so they use the kit (Accept = primary,
    // Reject = secondary), never the --success / --error status hues (#3065).
    await expect(acceptBtn).toHaveElementClass('ui-btn')
    await expect(acceptBtn).toHaveElementClass('ui-btn-primary')
    await expect(rejectBtn).toHaveElementClass('ui-btn')
    await expect(rejectBtn).toHaveElementClass('ui-btn-secondary')
    await expect($('#git-diff-viewer-host copse-ui-actions.diff-approval-bar')).toBeDisplayed()
    const approvalPaint = await browser.execute(() => {
      const bar = document.querySelector<HTMLElement>('#git-diff-viewer-host .diff-approval-bar')
      const accept = bar?.querySelector<HTMLElement>('.diff-accept-btn')
      const reject = bar?.querySelector<HTMLElement>('.diff-reject-btn')
      if (!bar || !accept || !reject) return null
      // Resolve tokens through the cascade with a probe in the bar's scope.
      const probe = document.createElement('span')
      bar.append(probe)
      const tokenColor = (token: string): string => {
        probe.style.color = `var(${token})`
        return getComputedStyle(probe).color
      }
      probe.style.columnGap = 'var(--spacing-md)'
      const spacingMd = getComputedStyle(probe).columnGap
      const acceptRect = accept.getBoundingClientRect()
      const rejectRect = reject.getBoundingClientRect()
      const paint = {
        acceptBg: getComputedStyle(accept).backgroundColor,
        rejectBg: getComputedStyle(reject).backgroundColor,
        gap: getComputedStyle(bar).columnGap,
        spacingMd,
        heightsMatch: acceptRect.height === rejectRect.height,
        accentFill: tokenColor('--accent-fill'),
        successHue: tokenColor('--success'),
        errorHue: tokenColor('--error'),
      }
      probe.remove()
      return paint
    })
    if (!approvalPaint) throw new Error('missing diff approval bar buttons')
    await expect(approvalPaint.acceptBg).toBe(approvalPaint.accentFill)
    await expect(approvalPaint.rejectBg).toBe('rgba(0, 0, 0, 0)')
    for (const fill of [approvalPaint.acceptBg, approvalPaint.rejectBg]) {
      await expect(fill).not.toBe(approvalPaint.successHue)
      await expect(fill).not.toBe(approvalPaint.errorHue)
    }
    await expect(approvalPaint.gap).toBe(approvalPaint.spacingMd)
    await expect(approvalPaint.heightsMatch).toBe(true)

    await saveAppScreenshot('staged-diff-single.png')

    await writeProposedFile(
      'Propose the second staged TypeScript file',
      'Create src/e2e-staged-b.ts with a constant named b set to 2.',
      'src/e2e-staged-b.ts',
      'export const b = 2\n',
      'I prepared the proposed change for src/e2e-staged-b.ts.',
    )

    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length === 2, {
      timeout: 30_000,
      timeoutMsg: 'expected two proposed diff rows',
    })

    await expect($('.git-changes-bulk-actions')).toBeDisplayed()
    await expect($('button*=Accept all')).toBeDisplayed()
    await expect($('button*=Reject all')).toBeDisplayed()

    const paths = await $$('.git-change-row-proposed .git-change-path').map((el) => el.getText())
    await expect(paths).toContain('src/e2e-staged-a.ts')
    await expect(paths).toContain('src/e2e-staged-b.ts')

    const rows = await $$('.git-change-row-proposed')
    const second = await rows.find(async (row) =>
      (await row.$('.git-change-path').getText()).includes('e2e-staged-b.ts'),
    )
    if (!second) throw new Error('missing e2e-staged-b.ts proposed row')
    await second.click()
    await expect(second).toHaveElementClass('is-selected')

    await saveAppScreenshot('staged-diff-multi.png')

    // Rapid selection used to start overlapping Monaco view-model computations;
    // the slower, stale request could win and leave the viewer blank or showing
    // the wrong file. Click both rows without waiting for either diff load.
    await browser.execute(() => {
      for (const path of ['src/e2e-staged-a.ts', 'src/e2e-staged-b.ts']) {
        const row = [
          ...document.querySelectorAll<HTMLButtonElement>('.git-change-row-proposed'),
        ].find((candidate) => candidate.textContent?.includes(path))
        row?.click()
      }
    })
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const selected = document.querySelector('.git-change-row-proposed.is-selected')
          const viewerText =
            document.querySelector('#git-diff-viewer-host')?.textContent?.replace(/\s/g, '') ?? ''
          return (
            selected?.textContent?.includes('src/e2e-staged-b.ts') === true &&
            viewerText.includes('exportconstb=2')
          )
        }),
      {
        timeout: 30_000,
        timeoutMsg: 'expected the last rapidly selected proposed diff to render',
      },
    )
    await saveAppScreenshot('staged-diff-rapid-selection.png')

    await $('.project-new-thread-btn').click()
    await expect($('.chat-row.selected .chat-title')).toHaveText('New Thread')
    await browser.waitUntil(async () => !(await $('.git-changes-section-proposed').isDisplayed()), {
      timeout: 10_000,
      timeoutMsg: "another thread must not display the first thread's proposed diffs",
    })
    await saveAppScreenshot('staged-diff-thread-isolated.png')

    const showMore = await $('.chats-show-more')
    if (await showMore.isExisting()) await showMore.click()
    await browser.execute(() => {
      const rows = [...document.querySelectorAll('.chats-list .chat-row')]
      const row = rows.find((candidate) => !candidate.classList.contains('selected'))
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await browser.waitUntil(async () => (await $$('.git-change-row-proposed')).length === 2, {
      timeout: 10_000,
      timeoutMsg: 'returning to the owner thread must restore its proposed diffs',
    })
  })

  it('accepting a CSS staged diff clears the view without error toasts', async function () {
    this.timeout(120_000)

    const rejectAllBtn = await $('button*=Reject all')
    if (await rejectAllBtn.isDisplayed()) {
      await rejectAllBtn.click()
      await browser.waitUntil(
        async () => !(await $('.git-changes-section-proposed').isDisplayed()),
        {
          timeout: 15_000,
          timeoutMsg: 'expected proposed section to close after reject all',
        },
      )
    }

    await writeProposedFile(
      'Propose a staged CSS change',
      'Create src/e2e-staged-layout.css with a muted projects settings button colour.',
      'src/e2e-staged-layout.css',
      ['.projects-settings-btn {', '  color: var(--text-muted);', '}', ''].join('\n'),
      'I prepared the proposed CSS change for src/e2e-staged-layout.css.',
    )

    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 15_000 })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 15_000 })

    const acceptBtn = await $('#git-diff-viewer-host .diff-accept-btn')
    await acceptBtn.waitForDisplayed({ timeout: 5_000 })
    await acceptBtn.click()

    await browser.waitUntil(async () => !(await $('.git-changes-section-proposed').isDisplayed()), {
      timeout: 15_000,
      timeoutMsg: 'expected proposed section to close after accept',
    })

    await browser.pause(3_000)
    await saveAppScreenshot('staged-diff-css-accept-no-error.png')
    await expect(await collectErrorToasts()).toEqual([])
  })

  it('shows Proposed rows in the Changes pop-out (#1718)', async function () {
    this.timeout(120_000)

    await writeProposedFile(
      'Propose a pop-out change',
      'Create a TypeScript file for the pop-out example.',
      'src/e2e-staged-popout.ts',
      'export const popout = true\n',
      'The pop-out example is ready for review.',
    )
    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 30_000 })

    const before = await browser.getWindowHandles()
    const popoutBtn = await $('#git-changes-host .pane-popout-btn')
    await popoutBtn.waitForClickable({ timeout: 10_000 })
    await popoutBtn.click()

    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 15_000,
      timeoutMsg: 'Changes pop-out window did not open',
    })
    const popoutHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h))
    if (!popoutHandle) throw new Error('Changes pop-out window handle missing')
    await browser.switchToWindow(popoutHandle)

    await browser.waitUntil(
      async () =>
        browser.execute(
          () => document.documentElement.getAttribute('data-popout-mode') === 'changes',
        ),
      {
        timeout: 20_000,
        timeoutMsg: 'pop-out did not boot in changes mode',
      },
    )
    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 30_000 })
    await expect($('.git-change-row-proposed .git-change-path')).toHaveText(
      'src/e2e-staged-popout.ts',
    )
    await saveAppScreenshot('staged-diff-popout-proposed.png')
    await browser.closeWindow()
    await browser.switchToWindow(before[0])
  })
})
