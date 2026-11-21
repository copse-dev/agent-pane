import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { $, $$, browser, expect } from '@wdio/globals'
import { Key } from 'webdriverio'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveAppScreenshot, saveElementScreenshot } from './helpers/screenshot.ts'
import {
  FOLDED_CODE_PAYLOAD,
  FOLDED_CODE_PROMPT,
  settleFoldedPromptCapture,
  assertFoldedPromptCaptureSettled,
} from './helpers/folded-code-prompt.ts'
import {
  acceptProtectedPrompt,
  composerText,
  setComposerValue,
  submitComposer,
} from './helpers/composer.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { waitForActiveThreadTitle, waitForAgentIdle } from './helpers.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const PROJECT_ID = 'e2e-paste-attachment-project'
const SCREENSHOT = 'paste-attachment-chip.png'
const TRANSCRIPT_SCREENSHOT = 'paste-attachment-transcript.png'
const COMPOSER_PREVIEW_SCREENSHOT = 'paste-attachment-composer-preview.png'
const TRANSCRIPT_PREVIEW_SCREENSHOT = 'paste-attachment-transcript-preview.png'

const SHORT_PASTE = 'The editor points:\n\n- tighten the intro\n- fix the typos'
// Starts with blank lines: the chip label must come from the first non-blank
// line, not render as an empty preview (the original bug).
const LONG_PASTE = `\n\nEditor feedback summary for the intro section\nThe opening repeats the product description twice. Keep the first explanation and remove the second. Shorten the final paragraph to one sentence that tells readers what to do next. Correct the spelling mistakes in the heading and button labels, and use the same name for the editor throughout the page.`
const PASTE_PROMPT = `Summarize this feedback: \n\n\`\`\`\n// Editor feedback summary for the intro section\n${LONG_PASTE}\n\`\`\``

async function waitForWorkspace(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const name = await $('.workspace-name').getElement()
      return (await name.isExisting()) && (await name.getText()) !== 'No folder'
    },
    { timeout: 30_000, timeoutMsg: 'expected workspace to be restored' },
  )
}

/** Real clipboard write + Ctrl+V so the composer's paste handler runs trusted. */
async function pasteIntoComposer(text: string): Promise<void> {
  const composer = await $('.prompt-input').getElement()
  await composer.click()
  await browser.execute(async (t) => {
    await navigator.clipboard.writeText(t)
  }, text)
  await browser.action('key').down(Key.Ctrl).down('v').up('v').up(Key.Ctrl).perform()
}

/** A chip's rendered top-left corner radius (the kit's `--radius` is 6px). */
async function chipCorner(selector: string): Promise<string | null> {
  return browser.execute((target: string) => {
    const chip = document.querySelector(target)
    return chip instanceof HTMLElement ? getComputedStyle(chip).borderTopLeftRadius : null
  }, selector)
}

describe('Pasting text into the composer', () => {
  let workspaceRoot = ''

  before(async function () {
    this.timeout(120_000)
    workspaceRoot = join(mkdtempSync(join(tmpdir(), 'copse-paste-attachment-')), 'workspace')
    mkdirSync(workspaceRoot)
    mkdirSync(join(process.cwd(), 'tests/e2e/screenshots'), { recursive: true })
    resetUserData()
    seedE2eViewport()
    seedEmptyProject(workspaceRoot, PROJECT_ID)
    await browser.reloadSession()
    await waitForWorkspace()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(() => {
    resetUserData()
    if (workspaceRoot) removeE2eTree(dirname(workspaceRoot))
  })

  it('keeps a short multi-line paste inline instead of folding it into a chip', async () => {
    await setComposerValue('')
    await pasteIntoComposer(SHORT_PASTE)

    await browser.waitUntil(async () => (await composerText()).includes('The editor points:'), {
      timeout: 5_000,
      timeoutMsg: 'expected short paste to land inline in the composer',
    })
    expect(await composerText()).toContain('- fix the typos')
    expect(await $('.inline-paste-chip').isExisting()).toBe(false)
  })

  it('folds a large paste into a chip inline at the caret, after the typed text', async () => {
    await setComposerValue('Summarize this feedback: ')
    await pasteIntoComposer(LONG_PASTE)

    // The chip lives inside the composer text flow (composer-editor.ts), not a
    // detached attachment row, and its label is the first non-blank line.
    const chip = await $('.prompt-input .inline-paste-chip').getElement()
    await chip.waitForDisplayed({ timeout: 5_000 })
    expect(await chip.getText()).toContain('Editor feedback summary')

    // The typed text stays, with the chip appended after it in the same line.
    const layout = await browser.execute(() => {
      const composer = document.querySelector('.prompt-input')
      if (!(composer instanceof HTMLElement)) return null
      const chipEl = composer.querySelector('.inline-paste-chip')
      const prefix = chipEl?.previousSibling?.textContent ?? ''
      return { prefix, raw: composer.textContent }
    })
    expect(layout?.prefix).toBe('Summarize this feedback: ')
    // The paste's full body is chip-internal state, never raw composer text.
    expect(layout?.raw).not.toContain('The opening repeats')
    // Attachment chips take the kit radius rather than a one-off 10px pill.
    expect(await chipCorner('.prompt-input .inline-paste-chip')).toBe('6px')

    await saveAppScreenshot(SCREENSHOT)

    const scenario = await installMockScenario({
      title: 'Summarize editor feedback',
      turns: [
        {
          // The agent receives the typed text plus the expanded paste block,
          // while the transcript keeps the compact paste chip.
          user: PASTE_PROMPT,
          responses: [
            {
              text: 'The feedback focuses on tightening the introduction and correcting typos; keep the revision concise.',
            },
          ],
        },
      ],
    })

    // Send it: the paste must render in the transcript as an inline SVG-icon
    // chip (composer block -> Message.attachments -> conversation.ts), not an
    // emoji or the raw pasted text.
    await submitComposer()
    // The sent row keeps re-rendering while the reply streams in, so an element
    // handle taken from it goes stale between finding the chip and reading it
    // (a WebDriver "stale element reference" in CI). Read the chip in-page,
    // the same way `layout` reads the composer above.
    const SENT_CHIP =
      '.messages-list .msg-user .transcript-attachment-chip.transcript-attachment-paste'
    const sentChip = await browser.waitUntil(
      () =>
        browser.execute((target: string) => {
          const chip = document.querySelector(target)
          if (!(chip instanceof HTMLElement)) return null
          const row = chip.closest('.msg-user')
          return {
            hasIcon: chip.querySelector('svg[data-icon="paste"]') !== null,
            text: chip.textContent,
            messageText: row?.querySelector('.message-text')?.textContent ?? '',
          }
        }, SENT_CHIP),
      { timeout: 10_000, timeoutMsg: 'expected the sent paste chip in the transcript' },
    )
    expect(sentChip.hasIcon).toBe(true)
    expect(sentChip.text).toContain('Editor feedback summary')
    expect(await chipCorner(SENT_CHIP)).toBe('6px')
    // The object-replacement placeholder that marks the paste position never
    // shows as literal text.
    expect(sentChip.messageText).not.toContain('￼')

    await waitForAgentIdle()
    await expect($('.messages-list .msg-assistant .message-text')).toHaveText(
      'The feedback focuses on tightening the introduction and correcting typos; keep the revision concise.',
      { containing: true },
    )
    const storedPrompt = await browser.execute(async (projectId: string) => {
      const threadId =
        document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId']
      if (!threadId) return null
      const messages = await window.api.threads.loadMessages(projectId, threadId)
      return messages.find((message) => message.role === 'user') ?? null
    }, PROJECT_ID)
    expect(storedPrompt?.promptRepresentation).toBe('canonical-provider')
    expect(storedPrompt?.attachments?.[0]?.projection).toBe('canonical-block')
    const settledPrompt = await browser.execute((target: string) => {
      const chip = document.querySelector(target)
      const row = chip?.closest('.msg-user')
      return row?.querySelector('.message-text')?.textContent ?? ''
    }, SENT_CHIP)
    expect(settledPrompt).toContain('Summarize this feedback:')
    expect(settledPrompt).not.toContain('```')
    expect(await $('.messages-list .msg-user .msg-user-fold-toggle').isExisting()).toBe(false)
    await scenario.assertComplete()
    // The stored prompt is the typed text plus the chip's placeholder, and the
    // mock title model does not match it, so this is the word-slice fallback
    // title: it must name the prompt's words without the placeholder glyph.
    await waitForActiveThreadTitle()
    await expect($('.chat-row.selected .chat-title')).toHaveText('Summarize this feedback')
    await saveAppScreenshot(TRANSCRIPT_SCREENSHOT)
  })

  /**
   * A chip shows a label; the body it stands for is invisible until it opens.
   * That has to work on both sides of send — in the composer, so a paste can be
   * checked before it is sent, and in the transcript, so the sent snapshot stays
   * inspectable. The transcript half regressed because the chip was rebuilt from
   * its label alone, dropping the snapshot the message already carried.
   */
  it('opens a pasted block in the preview modal, in the composer and after sending', async () => {
    await setComposerValue('Please apply this feedback: ')
    await pasteIntoComposer(LONG_PASTE)

    const chipLabel = await $('.prompt-input .inline-paste-chip-label.text-expandable').getElement()
    await chipLabel.waitForDisplayed({ timeout: 5_000 })
    expect(await chipLabel.getAttribute('role')).toBe('button')
    await chipLabel.click()

    const dialog = await $('dialog.attachment-preview-dialog[open]').getElement()
    await dialog.waitForExist({ timeout: 5_000 })
    expect(await dialog.getAttribute('data-preview-kind')).toBe('text')
    // The chip's label is the first non-blank line; the modal is where the rest
    // of the body — never raw composer text — becomes readable.
    await expect($('.attachment-preview-text')).toHaveText(
      expect.stringContaining('The opening repeats the product description twice.'),
    )
    await saveAppScreenshot(COMPOSER_PREVIEW_SCREENSHOT)
    await $('.attachment-preview-close').click()
    await dialog.waitForExist({ timeout: 5_000, reverse: true })

    // This spec has already sent one paste, so target the chip this send adds
    // rather than the one left in the transcript by the previous test.
    const sentChips =
      '.messages-list .msg-user .transcript-attachment-chip.transcript-attachment-paste'
    const before = (await $$(sentChips).getElements()).length
    await installMockScenario({
      title: 'Apply the editor feedback',
      turns: [
        {
          user: PASTE_PROMPT.replace('Summarize this feedback:', 'Please apply this feedback:'),
          responses: [
            {
              text: 'I’ll tighten the introduction, correct the typos, and make the editor name consistent.',
            },
          ],
        },
      ],
    })
    await submitComposer()
    await browser.waitUntil(async () => (await $$(sentChips).getElements()).length > before, {
      timeout: 10_000,
      timeoutMsg: 'expected the sent paste to render a transcript chip',
    })
    const sentChip = (await $$(sentChips).getElements()).at(-1)
    if (!sentChip) throw new Error('no transcript paste chip after send')
    expect(await sentChip.getAttribute('role')).toBe('button')
    await sentChip.click()

    const sentDialog = await $('dialog.attachment-preview-dialog[open]').getElement()
    await sentDialog.waitForExist({ timeout: 5_000 })
    await expect($('.attachment-preview-text')).toHaveText(
      expect.stringContaining('The opening repeats the product description twice.'),
    )
    await waitForAgentIdle()
    const settledRow = await browser.execute((target: string) => {
      const chips = document.querySelectorAll(target)
      const row = chips.item(chips.length - 1).closest('.msg-user')
      return {
        text: row?.querySelector('.message-text')?.textContent ?? '',
        folded: row?.querySelector('.msg-user-fold-toggle') !== null,
      }
    }, sentChips)
    expect(settledRow.text).toContain('Please apply this feedback:')
    expect(settledRow.text).not.toContain('```')
    expect(settledRow.folded).toBe(false)
    const settledPrompts = await browser.execute(() =>
      [...document.querySelectorAll('.messages-list .msg-user')].map((row) => ({
        text: row.querySelector('.message-text')?.textContent ?? '',
        folded: row.querySelector('.msg-user-fold-toggle') !== null,
      })),
    )
    const storedPrompts = await browser.execute(async (projectId: string) => {
      const threadId =
        document.querySelector<HTMLElement>('.chat-row.selected')?.dataset['threadId']
      if (!threadId) return []
      return (await window.api.threads.loadMessages(projectId, threadId))
        .filter((message) => message.role === 'user')
        .map((message) => ({
          content: message.content,
          promptRepresentation: message.promptRepresentation,
          attachments: message.attachments,
        }))
    }, PROJECT_ID)
    expect(settledPrompts).toHaveLength(2)
    expect(storedPrompts.map((prompt) => prompt.attachments?.[0]?.projection)).toEqual([
      'canonical-block',
      'canonical-block',
    ])
    expect(storedPrompts[0]?.content).toBe(PASTE_PROMPT)
    expect(storedPrompts[0]?.attachments?.[0]?.content).toBe(LONG_PASTE)
    expect(settledPrompts.map((prompt) => prompt.text.includes('```'))).toEqual([false, false])
    expect(settledPrompts.every((prompt) => !prompt.folded)).toBe(true)
    await saveAppScreenshot(TRANSCRIPT_PREVIEW_SCREENSHOT)
    await $('.attachment-preview-close').click()
  })

  it('resends a raw canonical fenced prompt without creating an empty code tail', async () => {
    // Settings resets retain persisted chats; start a fresh one through the UI.
    await $('.project-new-thread-btn').waitForClickable({ timeout: 30_000 })
    await $('.project-new-thread-btn').click()
    await $('.messages-list .msg-user').waitForExist({ timeout: 10_000, reverse: true })
    const scenario = await installMockScenario({
      title: 'Review notification configuration',
      turns: [
        { user: FOLDED_CODE_PROMPT, responses: [{ text: 'The timeout is thirty seconds.' }] },
        {
          user: FOLDED_CODE_PROMPT,
          responses: [{ text: 'The same configuration is still intact.' }],
        },
      ],
    })
    await setComposerValue(FOLDED_CODE_PROMPT)
    await $('.submit-btn').waitForEnabled({ timeout: 30_000 })
    await submitComposer()
    await scenario.waitForTurns(1)
    await waitForAgentIdle()
    await waitForActiveThreadTitle()
    await expect(await $$('.messages-list .msg-user').getElements()).toBeElementsArrayOfSize(1)
    const original = await $('.messages-list .msg-user').getElement()
    const originalId = await original.getAttribute('data-message-id')
    await original.moveTo()
    await original.$('.msg-resend').click()
    await acceptProtectedPrompt()
    await scenario.waitForComplete()
    await waitForAgentIdle()
    await scenario.assertComplete()
    const ids = await browser.execute(() =>
      [...document.querySelectorAll('.messages-list .msg-user')].map((row) =>
        row.getAttribute('data-message-id'),
      ),
    )
    expect(ids.length).toBe(2)
    expect(ids[0]).toBe(originalId)
    const resentId = ids[1]
    if (!resentId || resentId === originalId) throw new Error('Resend did not append a new message')
    const resent = `[data-message-id="${resentId}"]`
    const toggle = `${resent} .msg-user-fold-toggle`
    await expect($(toggle)).toHaveAttribute('aria-expanded', 'false')
    expect(await $(`${resent} .transcript-attachment-chip`).isExisting()).toBe(false)
    expect(await $(`${resent} .msg-user-fold-tail pre`).isExisting()).toBe(false)
    await expect($(`${resent} .msg-user-fold-tail`)).toHaveText('')
    await saveElementScreenshot(resent, 'paste-attachment-raw-resend-folded.png', {
      captureFromViewport: true,
      beforeCapture: () => settleFoldedPromptCapture(resent),
    })
    await assertFoldedPromptCaptureSettled(resent)
    await saveAppScreenshot('paste-attachment-raw-resend-folded-app.png')

    await $(toggle).click()
    await expect($(`${resent} .msg-user-fold-middle`)).toBeDisplayed()
    expect(
      await browser.execute(
        (selector) =>
          [...document.querySelectorAll(`${selector} pre code`)].map((code) => code.textContent),
        resent,
      ),
    ).toEqual([`${FOLDED_CODE_PAYLOAD}\n`])
    await saveElementScreenshot(resent, 'paste-attachment-raw-resend-expanded.png', {
      captureFromViewport: true,
      beforeCapture: () => settleFoldedPromptCapture(resent),
    })
    await assertFoldedPromptCaptureSettled(resent)
    await saveAppScreenshot('paste-attachment-raw-resend-expanded-app.png')
    await $(toggle).click()
    await browser.reloadSession()
    await $(toggle).waitForExist({ timeout: 30_000 })
    await expect($(toggle)).toHaveAttribute('aria-expanded', 'false')
    const restored = await browser.execute(() =>
      [...document.querySelectorAll('.messages-list .msg-user')].map((row) => ({
        id: row.getAttribute('data-message-id'),
        codes: [...row.querySelectorAll('pre code')].map((code) => code.textContent),
        tailBlocks: row.querySelectorAll('.msg-user-fold-tail pre').length,
      })),
    )
    expect(restored).toEqual([
      { id: originalId, codes: [`${FOLDED_CODE_PAYLOAD}\n`], tailBlocks: 0 },
      { id: resentId, codes: [`${FOLDED_CODE_PAYLOAD}\n`], tailBlocks: 0 },
    ])
    await saveAppScreenshot('paste-attachment-raw-resend-reloaded-app.png')
    // A real resend after reloading proves the restored canonical source is
    // still what reaches the provider, not merely equivalent rendered text.
    const restoredScenario = await installMockScenario({
      title: 'Review restored notification configuration',
      turns: [
        {
          user: FOLDED_CODE_PROMPT,
          responses: [{ text: 'The restored configuration is intact.' }],
        },
      ],
    })
    await $(resent).moveTo()
    await $(`${resent} .msg-resend`).click()
    await acceptProtectedPrompt()
    await restoredScenario.waitForComplete()
    await waitForAgentIdle()
    await restoredScenario.assertComplete()
    expect((await $$('.messages-list .msg-user').getElements()).length).toBe(3)
  })
})
