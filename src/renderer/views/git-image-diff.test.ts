import '../../../tests/setup-dom.ts'
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import type { GitFileDiff } from '@shared/types/git.ts'
import { isImageDiff, renderImageDiff } from './git-image-diff.ts'
import { qsRequired } from '../dom/helpers.ts'
import { patchPreviewDialog } from '../attachments/preview-dialog.test-support.ts'

const BEFORE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const AFTER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQMAAAAlBoUgAAAAA1BMVEX/AAAxeq7ZAAAAAXRSTlPM0jRW/QAAAApJREFUeJxjYAAAAAIAAeIhvDMAAAAASUVORK5CYII='

function mouseClick(target: EventTarget): void {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

function makeDiff(overrides: Partial<GitFileDiff> = {}): GitFileDiff {
  return {
    path: 'assets/logo.png',
    before: '',
    after: '',
    language: 'plaintext',
    beforeImage: BEFORE_PNG,
    afterImage: AFTER_PNG,
    ...overrides,
  }
}

describe('git image diff', () => {
  before(() => {
    patchPreviewDialog()
  })

  it('flags a diff carrying before/after image data as an image diff', () => {
    assert.equal(isImageDiff(makeDiff()), true)
    assert.equal(isImageDiff(makeDiff({ beforeImage: null, afterImage: null })), false)
  })

  it('renders expandable Before/After images with path- and side-specific alt text', () => {
    const container = document.createElement('div')
    document.body.append(container)
    renderImageDiff(container, makeDiff())

    const images = container.querySelectorAll<HTMLImageElement>('.git-image-diff-img')
    assert.equal(images.length, 2)
    assert.equal(images[0]?.alt, 'assets/logo.png (before)')
    assert.equal(images[1]?.alt, 'assets/logo.png (after)')
    for (const img of images) {
      assert.equal(img.classList.contains('image-expandable'), true)
      assert.equal(img.getAttribute('role'), 'button')
      assert.equal(img.getAttribute('tabindex'), '0')
    }
    container.remove()
  })

  it('opens the shared expand modal with the after image on click', () => {
    const container = document.createElement('div')
    document.body.append(container)
    renderImageDiff(container, makeDiff())

    const afterImg = qsRequired<HTMLImageElement>(container, '.git-image-diff-pane:last-child img')
    mouseClick(afterImg)

    const dialog = qsRequired(document, '.attachment-preview-dialog')
    const expanded = qsRequired<HTMLImageElement>(dialog, '.image-expand-image')
    assert.equal(expanded.src, AFTER_PNG)
    assert.equal(expanded.alt, 'assets/logo.png (after)')
    container.remove()
  })
})
