import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'
import { setComposerValue } from './helpers/composer.ts'

const projectId = 'image-link-project'
const threadId = 'image-link-thread'
const WORKSPACE_PATH_MIME = 'application/x-copse-panel-path'

describe('transcript workspace image links', () => {
  let parent = ''

  before(async () => {
    parent = mkdtempSync(join(tmpdir(), 'copse-image-links-'))
    const root = join(parent, 'workspace')
    mkdirSync(root)
    copyFileSync(
      join(process.cwd(), 'tests/e2e/fixtures/git-changes-blue.png'),
      join(root, 'chart.png'),
    )
    writeFileSync(
      join(root, 'diagram.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#203548"/><circle cx="110" cy="120" r="65" fill="#59dbbb"/><path d="M220 60h190v120H220z" fill="#eeab62"/><text x="240" y="132" text-anchor="middle" font-family="sans-serif" font-size="22" fill="white">Workspace image</text></svg>',
    )
    writeFileSync(join(root, 'README.md'), '# Image fixture\n')
    copyFileSync(join(root, 'chart.png'), join(parent, 'outside.png'))
    symlinkSync(join(parent, 'outside.png'), join(root, 'escape.png'))
    resetUserData()
    seedE2eViewport()
    writeSeedConfig({
      projects: [{ id: projectId, path: root, name: 'Image preview fixture' }],
      activeProjectId: projectId,
      [`threads:${projectId}`]: [
        {
          id: threadId,
          title: 'Preview workspace images',
          status: 'idle',
          messages: [
            {
              id: 'image-link-message',
              role: 'assistant',
              content:
                'Open [Chart](/chart.png), [Diagram](/diagram.svg), or [Readme](/README.md).',
              createdAt: Date.now(),
            },
          ],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
    if (parent) rmSync(parent, { recursive: true, force: true })
  })

  it('copies an image opened from a chat file link', async function () {
    this.timeout(60_000)
    const chart = $('.message-text a[href="/chart.png"]')
    await chart.waitForDisplayed({ timeout: 30_000 })
    await chart.click()
    const dialog = $('dialog.attachment-preview-dialog[open]')
    await dialog.waitForDisplayed({ timeout: 15_000 })

    try {
      const image = dialog.$('.image-expand-image')
      await image.waitForDisplayed({ timeout: 15_000 })
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const preview = document.querySelector<HTMLImageElement>(
              'dialog.attachment-preview-dialog[open] .image-expand-image',
            )
            return preview?.complete === true && preview.naturalWidth > 0
          }),
        { timeout: 15_000 },
      )
      await image.click({ button: 'right' })
      const copy = dialog.$('.context-menu-item')
      await expect(copy).toHaveText('Copy image')
      await saveAppScreenshot('transcript-image-copy-menu.png')
      await copy.click()

      const clipboardImage = await browser.execute(async () => {
        const first = (await navigator.clipboard.read())[0]
        if (!first || !first.types.includes('image/png')) return null
        const blob = await first.getType('image/png')
        return { type: blob.type, size: blob.size }
      })
      assert.equal(clipboardImage?.type, 'image/png')
      assert.ok((clipboardImage?.size ?? 0) > 0)
      await assertNoErrorToasts('chat file image copy')
    } finally {
      await dialog.$('.attachment-preview-close').click()
    }
  })

  it('decodes PNG and SVG previews through IPC and retains normal text navigation', async () => {
    const chart = $('.message-text a[href="/chart.png"]')
    await chart.waitForDisplayed({ timeout: 30_000 })
    await chart.click()
    await $('dialog.attachment-preview-dialog[open] .image-expand-image').waitForDisplayed({
      timeout: 15_000,
    })
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const image = document.querySelector<HTMLImageElement>('.image-expand-image')
          return image?.complete === true && image.naturalWidth > 0
        }),
      { timeout: 15_000 },
    )
    await expect($('.image-expand-image')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/png;base64,'),
    )
    await expect($('.attachment-preview-title')).toHaveText('chart.png')
    await $('.attachment-preview-close').click()

    await $('.message-text a[href="/diagram.svg"]').click()
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const image = document.querySelector<HTMLImageElement>('.image-expand-image')
          return image?.complete === true && image.naturalWidth === 480
        }),
      { timeout: 15_000 },
    )
    await expect($('.attachment-preview-title')).toHaveText('diagram.svg')
    await saveAppScreenshot('transcript-image-preview.png')
    await $('.attachment-preview-close').click()

    const denied = await browser.execute(
      async ({ projectId, threadId }) => {
        const results: string[] = []
        for (const path of ['../outside.png', 'escape.png', 'README.md']) {
          try {
            await window.api.fs.readImage(projectId, threadId, path)
            results.push('allowed')
          } catch {
            results.push('denied')
          }
        }
        return results
      },
      { projectId, threadId },
    )
    expect(denied).toEqual(['denied', 'denied', 'denied'])

    await $('.message-text a[href="/README.md"]').click()
    await $('.file-tree .tree-row[title="README.md"]').waitForDisplayed({ timeout: 15_000 })
    await assertNoErrorToasts('image and text workspace links')
  })

  it('attaches workspace images from mentions and explorer drags without reading text', async () => {
    await setComposerValue('@chart')
    const mention = await $('.mention-picker .mention-item')
    await mention.waitForDisplayed({ timeout: 15_000 })
    await expect(mention).toHaveText('chart.png')
    await mention.click()

    const imageChip = await $('.attachment-chip.image-chip')
    await imageChip.waitForDisplayed({ timeout: 15_000 })
    await expect($('.attachment-chip.image-chip img')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/png;base64,'),
    )
    await expect($('.attachment-chip:not(.image-chip)')).not.toBeExisting()
    await $('.attachment-chip.image-chip button').click()
    await expect(imageChip).not.toBeExisting()

    await setComposerValue('@diagram')
    const svgMention = await $('.mention-picker .mention-item')
    await svgMention.waitForDisplayed({ timeout: 15_000 })
    await expect(svgMention).toHaveText('diagram.svg')
    await svgMention.click()

    const svgChip = await $('.attachment-chip:not(.image-chip)')
    await svgChip.waitForDisplayed({ timeout: 15_000 })
    await expect(svgChip).toHaveText(expect.stringContaining('diagram.svg'))
    await expect($('.attachment-chip.image-chip')).not.toBeExisting()
    await svgChip.$('button').click()
    await expect(svgChip).not.toBeExisting()

    await browser.execute(
      ({ mime, path }) => {
        const dataTransfer = new DataTransfer()
        dataTransfer.setData(mime, path)
        document.getElementById('input-bar')?.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        )
      },
      { mime: WORKSPACE_PATH_MIME, path: 'chart.png' },
    )

    await $('.attachment-chip.image-chip').waitForDisplayed({ timeout: 15_000 })
    await expect($('.attachment-chip.image-chip img')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/png;base64,'),
    )
    await expect($('.attachment-chip:not(.image-chip)')).not.toBeExisting()
    await saveAppScreenshot('workspace-image-attachments.png')
    await assertNoErrorToasts('workspace image attachments')
  })
})
