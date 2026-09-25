import '../../../tests/setup-dom.ts'
import { before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { GitFileDiff } from '@shared/types/git.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'
import { renderImageDiff } from './git-image-diff.ts'

const BEFORE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const AFTER_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'

function imageDiff(images: Pick<GitFileDiff, 'beforeImage' | 'afterImage'>): GitFileDiff {
  return {
    path: 'assets/banner.png',
    before: '',
    after: '',
    language: 'binary',
    ...images,
  }
}

function keydown(target: Element, key: string): void {
  target.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  )
}

describe('git image diff expansion', () => {
  before(() => {
    patchPreviewDialog()
  })

  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('opens the correct before and after pixels with keyboard-accessible controls', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    renderImageDiff(host, imageDiff({ beforeImage: BEFORE_IMAGE, afterImage: AFTER_IMAGE }))

    const images = host.querySelectorAll<HTMLImageElement>('.git-image-diff-img')
    assert.equal(images.length, 2)
    const before = images[0]
    const after = images[1]
    assert.ok(before)
    assert.ok(after)
    assert.equal(before.getAttribute('role'), 'button')
    assert.equal(before.getAttribute('tabindex'), '0')
    assert.equal(before.getAttribute('aria-label'), 'Expand assets/banner.png (before)')
    assert.equal(after.getAttribute('aria-label'), 'Expand assets/banner.png (after)')

    before.focus()
    before.click()
    const dialog = qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog')
    let expanded = qsRequired<HTMLImageElement>(dialog, '.image-expand-image')
    assert.equal(expanded.src, BEFORE_IMAGE)
    assert.equal(expanded.alt, 'assets/banner.png (before)')

    qsRequired<HTMLButtonElement>(dialog, '.attachment-preview-close').click()
    await Promise.resolve()
    assert.equal(dialog.open, false)
    assert.equal(document.activeElement, before)

    after.focus()
    keydown(after, 'Enter')
    expanded = qsRequired<HTMLImageElement>(dialog, '.image-expand-image')
    assert.equal(expanded.src, AFTER_IMAGE)
    assert.equal(expanded.alt, 'assets/banner.png (after)')
  })

  it('restores focus to the equivalent side after a live diff refresh', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const diff = imageDiff({ beforeImage: BEFORE_IMAGE, afterImage: AFTER_IMAGE })
    renderImageDiff(host, diff)

    const originalBefore = qsRequired<HTMLImageElement>(
      host,
      '.git-image-diff-img[alt="assets/banner.png (before)"]',
    )
    originalBefore.focus()
    originalBefore.click()

    renderImageDiff(host, diff)
    const replacementBefore = qsRequired<HTMLImageElement>(
      host,
      '.git-image-diff-img[alt="assets/banner.png (before)"]',
    )
    assert.notEqual(replacementBefore, originalBefore)
    qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog').close()
    await Promise.resolve()

    assert.equal(document.activeElement, replacementBefore)
  })

  it('keeps added and deleted images expandable without inventing the missing side', () => {
    const host = document.createElement('div')
    document.body.append(host)

    renderImageDiff(host, imageDiff({ beforeImage: null, afterImage: AFTER_IMAGE }))
    let image = qsRequired<HTMLImageElement>(host, '.git-image-diff-img')
    assert.equal(host.querySelectorAll('.git-image-diff-img').length, 1)
    assert.equal(image.alt, 'assets/banner.png (after)')
    keydown(image, ' ')
    assert.equal(qsRequired<HTMLImageElement>(document, '.image-expand-image').src, AFTER_IMAGE)
    qsRequired<HTMLDialogElement>(document, '.attachment-preview-dialog').close()

    renderImageDiff(host, imageDiff({ beforeImage: BEFORE_IMAGE, afterImage: null }))
    image = qsRequired<HTMLImageElement>(host, '.git-image-diff-img')
    assert.equal(host.querySelectorAll('.git-image-diff-img').length, 1)
    assert.equal(image.alt, 'assets/banner.png (before)')
    image.click()
    assert.equal(qsRequired<HTMLImageElement>(document, '.image-expand-image').src, BEFORE_IMAGE)
  })
})
