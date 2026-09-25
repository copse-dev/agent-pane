import type { GitFileDiff } from '@shared/types/git.ts'
import { attachImageExpand } from '../attachments/image-expand.ts'
import { clear, el } from '../dom/helpers.ts'

export function isImageDiff(diff: GitFileDiff): boolean {
  return diff.beforeImage != null || diff.afterImage != null
}

export function renderImageDiff(container: HTMLElement, diff: GitFileDiff): void {
  clear(container)
  const grid = el('div', { class: 'git-image-diff' })

  if (diff.beforeImage) {
    const alt = `${diff.path} (before)`
    const img = el('img', {
      class: 'git-image-diff-img',
      src: diff.beforeImage,
      alt,
      loading: 'lazy',
    })
    attachImageExpand(img, alt)
    const pane = el('div', { class: 'git-image-diff-pane' })
    pane.append(el('div', { class: 'git-image-diff-label' }, 'Before'), img)
    grid.append(pane)
  }

  if (diff.afterImage) {
    const alt = `${diff.path} (after)`
    const img = el('img', {
      class: 'git-image-diff-img',
      src: diff.afterImage,
      alt,
      loading: 'lazy',
    })
    attachImageExpand(img, alt)
    const pane = el('div', { class: 'git-image-diff-pane' })
    pane.append(el('div', { class: 'git-image-diff-label' }, 'After'), img)
    grid.append(pane)
  }

  if (!diff.beforeImage && !diff.afterImage) {
    grid.append(el('div', { class: 'panel-empty' }, 'Could not load image'))
  }

  container.append(grid)
}
