import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { installMockScenario, expectAssistantReply } from './helpers/mock-scenario.ts'
import { prepareE2eScreenshot, savePreparedAppScreenshot } from './helpers/screenshot.ts'
import {
  cleanupGitChangesFixture,
  resetUserData,
  seedGitChangesFixture,
} from './helpers/seed-config.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const CHANGED_LINE = 'export const value = 2'
const COMMENT = 'Read this from config instead of hard-coding it.'
// What the agent receives for that one comment (formatLineCommentBatch).
const BATCH = [
  'I left a review comment on your changes. Please address it:',
  '',
  '1. `staged.ts` line 30:',
  '   ```',
  `   ${CHANGED_LINE}`,
  '   ```',
  `   ${COMMENT}`,
].join('\n')

async function openChanges(): Promise<void> {
  await $('.workspace-name').waitForExist({ timeout: 60_000 })
  await browser.waitUntil(
    async () => (await (await $('.workspace-name').getElement()).getText()) !== 'No folder',
    { timeout: 60_000, timeoutMsg: 'expected a restored workspace before opening Changes' },
  )
  await $('.prompt-input').waitForExist({ timeout: 60_000 })
  await $('.titlebar-btn[aria-label="Open review"]').waitForExist({ timeout: 30_000 })
  await $('.titlebar-btn[aria-label="Open review"]').click()
  await $('#git-changes-host').waitForDisplayed({ timeout: 30_000 })
}

/** Viewport point of the glyph margin beside the changed line in the "after" editor. */
async function changedLineGutter(): Promise<{ x: number; y: number } | null> {
  return browser.execute((text) => {
    const editor = document.querySelector('#git-diff-viewer-host .modified-in-monaco-diff-editor')
    if (!editor) return null
    const line = [...editor.querySelectorAll<HTMLElement>('.view-line')].find(
      (node) => node.textContent.replaceAll(String.fromCharCode(160), ' ') === text,
    )
    const glyphs = editor.querySelector('.glyph-margin')
    if (!line || !glyphs) return null
    const lineBox = line.getBoundingClientRect()
    const glyphBox = glyphs.getBoundingClientRect()
    if (glyphBox.width === 0) return null
    return {
      x: Math.round(glyphBox.left + glyphBox.width / 2),
      y: Math.round(lineBox.top + lineBox.height / 2),
    }
  }, CHANGED_LINE)
}

// Batched line comments on an agent's diff: "+" in the gutter, a comment box
// under the line, a bar counting what is waiting, and one message to the agent.
describe('Changes line comments', function () {
  this.timeout(120_000)

  let repoRoot = ''

  after(() => {
    resetUserData()
    if (repoRoot) cleanupGitChangesFixture(repoRoot)
  })

  it('collects a line comment and sends it to the agent as one message', async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    resetUserData()
    repoRoot = seedGitChangesFixture()
    await browser.reloadSession()
    await openChanges()

    await $('.git-change-row*=staged.ts').click()
    await browser.waitUntil(async () => (await changedLineGutter()) !== null, {
      timeout: 30_000,
      timeoutMsg: 'Expected the changed line of staged.ts in the diff',
    })
    const gutter = await changedLineGutter()
    if (!gutter) throw new Error('The changed line left the diff')
    const { x, y } = gutter
    await browser.action('pointer').move({ x, y }).perform()
    await $('#git-diff-viewer-host .diff-line-comment-add').waitForDisplayed({ timeout: 10_000 })
    await browser.action('pointer').move({ x, y }).down().up().perform()

    const input = $('#git-diff-viewer-host .diff-line-comment.is-draft textarea')
    await input.waitForDisplayed({ timeout: 10_000 })
    await expect(input).toBeFocused()
    await input.setValue(COMMENT)
    await $('#git-diff-viewer-host .diff-line-comment-save').click()

    const saved = $('#git-diff-viewer-host .diff-line-comment-body')
    await saved.waitForDisplayed({ timeout: 10_000 })
    await expect(saved).toHaveText(COMMENT)
    await expect($('.diff-line-comments-count')).toHaveText('1 review comment')
    await expect($('.diff-line-comments-send')).toBeDisplayed()
    // The card sits directly under the line it is about.
    const placement = await browser.execute((text) => {
      const card = document.querySelector('#git-diff-viewer-host .diff-line-comment')
      const line = [
        ...document.querySelectorAll<HTMLElement>(
          '#git-diff-viewer-host .modified-in-monaco-diff-editor .view-line',
        ),
      ].find((node) => node.textContent.replaceAll(String.fromCharCode(160), ' ') === text)
      if (!card || !line) return null
      return card.getBoundingClientRect().top - line.getBoundingClientRect().bottom
    }, CHANGED_LINE)
    expect(placement).not.toBeNull()
    expect(Math.abs(placement ?? 99)).toBeLessThan(12)

    await prepareE2eScreenshot()
    await browser.action('pointer').move({ x: 1, y: 1 }).perform()
    await savePreparedAppScreenshot('git-changes-line-comments.png')

    const scenario = await installMockScenario({
      title: 'Review comments',
      turns: [{ user: BATCH, responses: [{ text: 'Moved the value into config.' }] }],
    })
    await $('.diff-line-comments-send').click()
    // The fixture checkout is dirty, so the composer's guard asks first; the
    // batch waits in the composer until the user answers.
    await $('button=Send anyway').click()
    await scenario.waitForComplete()
    await expectAssistantReply('Moved the value into config.')
    await expect($('.msg-user')).toHaveText(expect.stringContaining(COMMENT))
    await expect($('.diff-line-comments-bar')).not.toBeDisplayed()
    await expect($('#git-diff-viewer-host .diff-line-comment')).not.toBeExisting()
  })
})
