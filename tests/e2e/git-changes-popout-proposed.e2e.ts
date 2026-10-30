import { at } from '@copse/std/array-utils.ts'
import {
  expectAssistantReply,
  installMockScenario,
  type ScenarioHandle,
} from './helpers/mock-scenario.ts'
import { setComposerValue } from './helpers/composer.ts'
import { acceptanceWakeTurn, readTranscriptNotices } from './helpers/acceptance-wake.ts'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { waitForAgentIdle } from './helpers.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { withCaptureFrame } from './helpers/screenshot.ts'
import {
  assertPopoutModesAllShown,
  assertPopoutModesOverflowAt,
} from './helpers/popout-panel-bar.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const PROJECT_ID = 'e2e-popout-proposed-project'
// A non-git workspace (outside any enclosing repo — git walks up from nested
// dirs): `canApplyDirectly` requires git, so every mock write stages a proposed
// diff for approval instead of applying directly.
const WORKSPACE = join(tmpdir(), 'copse-e2e-popout-proposed-workspace')

// #1753 / #1704. Proposed diffs reach every app window; the docked Changes pane
// and a Changes pop-out must both render them coloured through proposals made
// while the pop-out is open, approvals made in either window, and a proposal
// arriving while the main window's panel is closed.

const PROPOSED_REPLY = 'The proposed file change is ready for review.'

/**
 * Propose `path` in one scripted turn. Accepting a proposal wakes its turn with
 * a hidden prompt, so a proposal the spec will accept passes `acceptedReply`:
 * the scenario then scripts that wake, and the caller waits for it to finish.
 */
async function proposeFileChange(
  path: string,
  content: string,
  acceptedReply?: string,
): Promise<ScenarioHandle> {
  const user = `Propose an update to ${path}.`
  const scenario = await installMockScenario({
    title: user.replace(/[.!?]$/, ''),
    turns: [
      {
        user,
        responses: [
          { toolCalls: [{ name: 'write_file', args: { path, content } }] },
          { text: PROPOSED_REPLY, expectToolResults: [{ name: 'write_file' }] },
        ],
      },
      ...(acceptedReply === undefined ? [] : [acceptanceWakeTurn([path], acceptedReply)]),
    ],
  })
  await setComposerValue(user)
  await $('.submit-btn').click()
  // Every proposal ends with the same reply; wait for this turn's own.
  await scenario.waitForTurns(1)
  await expectAssistantReply(PROPOSED_REPLY)
  await waitForAgentIdle()
  if (acceptedReply === undefined) await scenario.assertComplete()
  return scenario
}

async function hasDecorations(): Promise<boolean> {
  return browser.execute(() => {
    const host = document.querySelector('#git-diff-viewer-host')
    return host?.querySelector('.line-insert, .char-insert, .line-delete, .char-delete') != null
  })
}

async function describeViewer(): Promise<string> {
  return browser.execute(() => {
    const host = document.querySelector('#git-diff-viewer-host')
    if (!host) return 'no #git-diff-viewer-host'
    return JSON.stringify({
      selected:
        document.querySelector('.git-change-row.is-selected .git-change-path')?.textContent ?? null,
      hasEditor: host.querySelector('.monaco-diff-editor') != null,
      inserts: host.querySelectorAll('.line-insert, .char-insert').length,
      deletes: host.querySelectorAll('.line-delete, .char-delete').length,
    })
  })
}

describe('proposed diffs across embed and pop-out (#1753)', function () {
  this.timeout(300_000)

  let mainHandle = ''
  let popoutHandle = ''

  before(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    mkdirSync(WORKSPACE, { recursive: true })
    resetUserData()
    seedEmptyProject(WORKSPACE, PROJECT_ID, {
      subagentsEnabled: false,
      model: 'claude-sonnet-4-6',
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 60_000 })
    mainHandle = at([...(await browser.getWindowHandles())], 0)
  })

  after(async () => {
    try {
      await browser.switchToWindow(mainHandle)
    } catch {
      // session already gone
    }
    resetUserData()
    removeE2eTree(WORKSPACE)
  })

  it('keeps the embed coloured through proposals and pop-out approvals', async () => {
    // First proposal opens the Changes panel and stages the diff.
    await proposeFileChange('src/e2e-popout-a.ts', 'export const a = 1\n')
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
    await $('.git-changes-section-proposed').waitForDisplayed({ timeout: 30_000 })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `embed never coloured the first proposal: ${await describeViewer()}`,
    })

    // Pop the Changes pane out.
    const before = await browser.getWindowHandles()
    await $('#git-changes-host .pane-popout-btn').click()
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length > before.length, {
      timeout: 15_000,
      timeoutMsg: 'expected a pop-out window',
    })
    const newHandle = (await browser.getWindowHandles()).find((h) => !before.includes(h))
    if (!newHandle) throw new Error('Expected a new pop-out window handle')
    popoutHandle = newHandle

    await browser.switchToWindow(popoutHandle)
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out never coloured the proposal: ${await describeViewer()}`,
    })

    // Second proposal from the main window while the pop-out is open. The spec
    // accepts it below, which wakes its turn.
    await browser.switchToWindow(mainHandle)
    const acceptedReply = 'src/e2e-popout-b.ts is on disk and exports b = 2.'
    const proposalB = await proposeFileChange(
      'src/e2e-popout-b.ts',
      'export const b = 2\n',
      acceptedReply,
    )
    const promptsBeforeAccept = (await readTranscriptNotices()).prompts
    await browser.waitUntil(
      async () => (await $$('.git-change-row-proposed').getElements()).length === 2,
      {
        timeout: 30_000,
        timeoutMsg: 'expected two proposed rows in the embed',
      },
    )
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `embed lost colouring on the second proposal: ${await describeViewer()}`,
    })

    await browser.switchToWindow(popoutHandle)
    await browser.waitUntil(
      async () => (await $$('.git-change-row-proposed').getElements()).length === 2,
      {
        timeout: 30_000,
        timeoutMsg: 'expected two proposed rows in the pop-out',
      },
    )
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out lost colouring on the second proposal: ${await describeViewer()}`,
    })
    // A Changes badge widens its button; the roomy titlebar still shows every
    // mode rather than folding Browser into the … menu.
    await assertPopoutModesAllShown()
    await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-popout-proposed.png'))
    // …while a narrow pop-out still folds trailing modes into the … menu.
    await assertPopoutModesOverflowAt(360)

    // Approve the selected diff in the pop-out; both windows fall back to the
    // remaining proposal and must colour it.
    const acceptBtn = await $('#git-diff-viewer-host .diff-accept-btn').getElement()
    // Accept is the kit primary, not a --success fill (#3065).
    await expect(acceptBtn).toHaveElementClass('ui-btn-primary')
    await acceptBtn.waitForDisplayed({ timeout: 10_000 })
    await acceptBtn.click()
    await browser.waitUntil(
      async () => (await $$('.git-change-row-proposed').getElements()).length === 1,
      {
        timeout: 30_000,
        timeoutMsg: 'expected the approved row to leave the pop-out queue',
      },
    )
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out uncoloured after its own approve: ${await describeViewer()}`,
    })

    await browser.switchToWindow(mainHandle)
    await browser.waitUntil(
      async () => (await $$('.git-change-row-proposed').getElements()).length === 1,
      {
        timeout: 30_000,
        timeoutMsg: 'expected the approved row to leave the embed queue',
      },
    )
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `embed uncoloured after the pop-out approve: ${await describeViewer()}`,
    })

    // The approval woke b's turn: its scripted reply lands with no new chat
    // prompt, and no request went unscripted.
    await proposalB.waitForComplete()
    await expectAssistantReply(acceptedReply)
    await waitForAgentIdle()
    await proposalB.assertComplete()
    expect(await readTranscriptNotices()).toEqual({ prompts: promptsBeforeAccept, cautions: [] })
  })

  it('force-opens the embed coloured when a proposal arrives with its panel closed', async () => {
    // The realistic sequence behind #1753: the user works in the pop-out with
    // the main window's panel closed; a new proposal must reveal a coloured
    // embed.
    await browser.switchToWindow(mainHandle)
    const paneFiles = await $('#pane-files').getElement()
    if (await paneFiles.isDisplayed()) {
      await $('.titlebar-btn[aria-label="Open changes"]').click()
      await browser.waitUntil(async () => !(await paneFiles.isDisplayed()), {
        timeout: 10_000,
        timeoutMsg: 'expected the main-window panel to close',
      })
    }

    await proposeFileChange('src/e2e-popout-c.ts', 'export const c = 3\n')
    await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
    await $('#git-diff-viewer-host .monaco-diff-editor').waitForDisplayed({ timeout: 30_000 })
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `force-opened embed is uncoloured: ${await describeViewer()}`,
    })
    expect((await readTranscriptNotices()).cautions).toEqual([])
    await withCaptureFrame(async () => {
      await browser.saveScreenshot(join(SCREENSHOT_DIR, 'git-changes-popout-proposed-forced.png'))
    })

    await browser.switchToWindow(popoutHandle)
    await browser.waitUntil(hasDecorations, {
      timeout: 15_000,
      timeoutMsg: `pop-out uncoloured for the third proposal: ${await describeViewer()}`,
    })
    try {
      await browser.closeWindow()
    } catch {
      // leave it for session teardown
    }
    await browser.switchToWindow(mainHandle)
  })
})
