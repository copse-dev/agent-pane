import assert from 'node:assert/strict'
import { $, $$, browser, expect } from '@wdio/globals'
import {
  invalidateThreadCatalog,
  resetUserData,
  seedStableWorkspace,
  seedThreadReferenceFixture,
} from './helpers/seed-config.ts'
import { setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

describe('@-reference past threads (#644)', () => {
  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    const { projectId } = seedThreadReferenceFixture(seedStableWorkspace())
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    // The outgoing Electron process may recreate an empty derived catalog
    // during reloadSession(). Invalidate it after the replacement process has
    // restored the seeded project so the picker rebuilds from its thread dirs.
    invalidateThreadCatalog(projectId)
  })

  after(() => {
    resetUserData()
  })

  it('inserts a stable inline thread chip and keeps it inline after send', async () => {
    // Filter on the seeded title so this interaction test does not also depend
    // on catalog digest extraction (covered by thread-store unit tests).
    await setComposerValue('From @auth')

    const threadItem = await $('.mention-picker .mention-item-thread')
    await threadItem.waitForDisplayed({ timeout: 10_000 })

    // Both seeded past threads are offered (the active thread is excluded).
    const threadItems = await $$('.mention-picker .mention-item-thread')
    await expect(threadItems).toBeElementsArrayOfSize({ gte: 1 })
    await expect($('.mention-item-thread svg.mention-thread-icon')).toBeExisting()

    await saveAppScreenshot('thread-reference-picker-open.png')

    await threadItem.click()
    const chip = await $('.prompt-input .inline-thread-chip')
    await chip.waitForDisplayed({ timeout: 10_000 })
    await expect(chip).toHaveText(expect.stringContaining('Auth refactor plan'))
    await expect(chip.$('svg.thread-chip-icon[data-icon="thread"]')).toBeExisting()
    await expect(chip.$('svg[data-icon="close"]')).toBeExisting()
    await expect($('.attachment-chips .thread-chip')).not.toBeExisting()
    await expect($('.mention-picker')).not.toBeDisplayed()

    const alignment = await browser.execute(() => {
      const inlineChip = document.querySelector<HTMLElement>('.inline-thread-chip')
      const label = inlineChip?.querySelector<HTMLElement>('.inline-thread-chip-label')
      const threadIcon = inlineChip?.querySelector<SVGElement>('svg[data-icon="thread"]')
      const closeIcon = inlineChip?.querySelector<SVGElement>('svg[data-icon="close"]')
      const before = inlineChip?.previousSibling
      if (!inlineChip || !label || !threadIcon || !closeIcon || !before) return null

      const textRange = document.createRange()
      textRange.selectNodeContents(before)
      const labelRange = document.createRange()
      labelRange.selectNodeContents(label)
      const labelRect = label.getBoundingClientRect()
      const threadRect = threadIcon.getBoundingClientRect()
      const closeRect = closeIcon.getBoundingClientRect()
      return {
        textBottom: textRange.getBoundingClientRect().bottom,
        labelBottom: labelRange.getBoundingClientRect().bottom,
        labelCenter: labelRect.top + labelRect.height / 2,
        threadCenter: threadRect.top + threadRect.height / 2,
        closeCenter: closeRect.top + closeRect.height / 2,
      }
    })
    assert.ok(alignment, 'expected measurable thread-chip geometry')
    assert.ok(
      Math.abs(alignment.textBottom - alignment.labelBottom) <= 2,
      'the thread label shares the surrounding sentence baseline',
    )
    assert.ok(
      Math.abs(alignment.threadCenter - alignment.labelCenter) <= 1,
      'the thread icon is vertically centered with the label',
    )
    assert.ok(
      Math.abs(alignment.closeCenter - alignment.labelCenter) <= 1,
      'the close icon is vertically centered with the label',
    )

    const readChipRect = async () =>
      browser.execute(() => {
        const rect = document.querySelector('.inline-thread-chip')?.getBoundingClientRect()
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
      })
    const beforeHover = await readChipRect()
    assert.ok(beforeHover)
    await chip.moveTo()
    await browser.pause(150)
    const afterHover = await readChipRect()
    assert.ok(afterHover)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      assert.ok(
        Math.abs(beforeHover[key] - afterHover[key]) <= 0.25,
        `hover must not change the chip's ${key}`,
      )
    }

    // The kit radius, like every other attachment/reference chip.
    const radius = await browser.execute(() => {
      const inlineChip = document.querySelector('.prompt-input .inline-thread-chip')
      if (!(inlineChip instanceof HTMLElement)) return null
      return {
        chip: getComputedStyle(inlineChip).borderTopLeftRadius,
        token: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
      }
    })
    assert.ok(radius, 'expected the inline thread chip')
    assert.equal(radius.chip, radius.token)

    await saveAppScreenshot('thread-reference-chip.png')

    await browser.execute(() => {
      const composer = document.querySelector<HTMLElement>('.prompt-input')
      const selection = window.getSelection()
      if (!composer || !selection) return
      composer.focus()
      const range = document.createRange()
      range.selectNodeContents(composer)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await browser.keys(' can you compare the proposal?')
    const reply =
      'The referenced auth plan proposes separating authentication policy from transport concerns.'
    const scenario = await installMockScenario({
      title: 'Compare the auth proposal',
      turns: [
        {
          user: { includes: 'can you compare the proposal?' },
          responses: [{ text: reply }],
        },
      ],
    })
    await $('.submit-btn').click()

    const sentChip = await $('.msg-user .message-text > .transcript-attachment-thread')
    await sentChip.waitForDisplayed({ timeout: 30_000 })
    await expect(sentChip).toHaveText(expect.stringContaining('Auth refactor plan'))
    await expect(sentChip.$('svg[data-icon="thread"]')).toBeExisting()
    await expect(
      $('.msg-user .transcript-attachment-row .transcript-attachment-thread'),
    ).not.toBeExisting()

    await expectAssistantReply(reply)
    await waitForAgentIdle()
    await scenario.assertComplete()
    await saveAppScreenshot('thread-reference-sent-inline.png')
  })
})
