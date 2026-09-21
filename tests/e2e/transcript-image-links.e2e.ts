import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { assertNoErrorToasts } from './helpers/assert-no-error-toasts.ts'

const projectId = 'image-link-project'
const threadId = 'image-link-thread'

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
})
