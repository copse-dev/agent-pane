import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import {
  FOLDED_CODE_PAYLOAD,
  FOLDED_CODE_PROMPT,
  settleFoldedPromptCapture,
  assertFoldedPromptCaptureSettled,
} from './helpers/folded-code-prompt.ts'
import { waitForActiveThreadTitle, waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

describe('fenced user prompt mid-fold accordion', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(90_000)
    workspaceRoot = mkdtempSync(join(tmpdir(), 'copse-fenced-fold-'))
    const workspace = join(workspaceRoot, 'workspace')
    mkdirSync(workspace)
    resetUserData()
    seedEmptyProject(workspace, 'e2e-user-fenced-fold-project')
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) removeE2eTree(workspaceRoot)
  })

  it('folds fenced code without an empty closing block and restores it after reload', async () => {
    const scenario = await installMockScenario({
      title: 'Review notification configuration',
      turns: [
        { user: FOLDED_CODE_PROMPT, responses: [{ text: 'The timeout is thirty seconds.' }] },
      ],
    })
    await setComposerValue(FOLDED_CODE_PROMPT)
    await $('.submit-btn').waitForEnabled({ timeout: 30_000 })
    await submitComposer()
    await scenario.waitForComplete()
    await waitForAgentIdle()
    await scenario.assertComplete()
    await waitForActiveThreadTitle()
    const row = '.messages-list .msg-user'
    const toggle = `${row} .msg-user-fold-toggle`
    await expect($(toggle)).toHaveAttribute('aria-expanded', 'false')
    await expect($(`${row} .msg-user-fold-middle`)).not.toBeDisplayed()
    const collapsed = await browser.execute((selector) => {
      const row = document.querySelector(selector)
      const toggle = row?.querySelector('.msg-user-fold-toggle')
      return {
        emptyTailBlocks: row?.querySelectorAll('.msg-user-fold-tail pre').length,
        tailText: row?.querySelector('.msg-user-fold-tail')?.textContent,
        radius: toggle ? getComputedStyle(toggle).borderTopLeftRadius : null,
      }
    }, row)
    expect(collapsed).toEqual({ emptyTailBlocks: 0, tailText: '', radius: '6px' })
    await saveElementScreenshot(row, 'user-prompt-fenced-fold-collapsed.png', {
      captureFromViewport: true,
      beforeCapture: () => settleFoldedPromptCapture(row),
    })
    await assertFoldedPromptCaptureSettled(row)
    await saveAppScreenshot('user-prompt-fenced-fold-collapsed-app.png')

    await $(toggle).click()
    await expect($(toggle)).toHaveAttribute('aria-expanded', 'true')
    await expect($(`${row} .msg-user-fold-middle`)).toBeDisplayed()
    const codes = await browser.execute(
      (selector) =>
        [...document.querySelectorAll(`${selector} pre code`)].map((code) => code.textContent),
      row,
    )
    expect(codes).toEqual([`${FOLDED_CODE_PAYLOAD}\n`])
    await saveElementScreenshot(row, 'user-prompt-fenced-fold-expanded.png', {
      captureFromViewport: true,
      beforeCapture: () => settleFoldedPromptCapture(row),
    })
    await assertFoldedPromptCaptureSettled(row)
    await saveAppScreenshot('user-prompt-fenced-fold-expanded-app.png')
    await $(toggle).click()
    await browser.reloadSession()
    await $(toggle).waitForExist({ timeout: 30_000 })
    await expect($(toggle)).toHaveAttribute('aria-expanded', 'false')
    expect(
      await browser.execute(
        (selector) =>
          [...document.querySelectorAll(`${selector} pre code`)].map((code) => code.textContent),
        row,
      ),
    ).toEqual([`${FOLDED_CODE_PAYLOAD}\n`])
    expect(await $(`${row} .msg-user-fold-tail pre`).isExisting()).toBe(false)
    await saveAppScreenshot('user-prompt-fenced-fold-reloaded-app.png')
  })
  it('keeps a crossing list fence in its original container after reload', async () => {
    await $('.project-new-thread-btn').waitForClickable({ timeout: 30_000 })
    await $('.project-new-thread-btn').click()
    await $('.messages-list .msg-user').waitForExist({ timeout: 10_000, reverse: true })
    const payload = Array.from(
      { length: 12 },
      (_, i) => `setting_${String(i)} = ${String(i)}`,
    ).join('\n')
    const source = [
      '- Configuration changes',
      '  ~~~text',
      ...payload.split('\n').map((line) => `  ${line}`),
      '  ~~~',
      '  Keep these settings together.',
      '',
      'What should change?',
    ].join('\n')
    const scenario = await installMockScenario({
      title: 'Review a nested configuration',
      turns: [{ user: source, responses: [{ text: 'The nested configuration is intact.' }] }],
    })
    await setComposerValue(source)
    await $('.submit-btn').waitForEnabled({ timeout: 30_000 })
    await submitComposer()
    await scenario.waitForComplete()
    await waitForAgentIdle()
    await scenario.assertComplete()
    await waitForActiveThreadTitle()
    const row = '.messages-list .msg-user'
    async function assertListContext(): Promise<void> {
      const state = await browser.execute((selector) => {
        const row = document.querySelector(selector)
        return {
          foldControls: row?.querySelectorAll('.msg-user-fold-toggle').length,
          nestedCode: row?.querySelector('li pre code')?.textContent,
          rootCodeBlocks: [...(row?.querySelectorAll('pre') ?? [])].filter(
            (pre) => !pre.closest('li'),
          ).length,
          keptItemProse: row
            ?.querySelector('li')
            ?.textContent.includes('Keep these settings together.'),
          keptFinalAsk: row?.textContent.includes('What should change?'),
        }
      }, row)
      expect(state).toEqual({
        foldControls: 0,
        nestedCode: `${payload}\n`,
        rootCodeBlocks: 0,
        keptItemProse: true,
        keptFinalAsk: true,
      })
      await expect($(`${row} li pre code`)).toBeDisplayed()
    }
    await assertListContext()
    await browser.reloadSession()
    await $(row).waitForExist({ timeout: 30_000 })
    await waitForAgentIdle()
    await waitForActiveThreadTitle()
    await assertListContext()
    await settleFoldedPromptCapture(row)
    await saveAppScreenshot('user-prompt-list-fence-app.png')
    await assertFoldedPromptCaptureSettled(row)
  })
})
