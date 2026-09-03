import type { GitFileDiff } from '@shared/types/git.ts'
import { clear, el } from '../dom/helpers.ts'

export function isImageDiff(diff: GitFileDiff): boolean {
  return diff.beforeImage != null || diff.afterImage != null
}

export function renderImageDiff(container: HTMLElement, diff: GitFileDiff): void {
  clear(container)
  const grid = el('div', { class: 'git-image-diff' })

  if (diff.beforeImage) {
    const pane = el('div', { class: 'git-image-diff-pane' })
    pane.append(
      el('div', { class: 'git-image-diff-label' }, 'Before'),
      el('img', {
        class: 'git-image-diff-img',
        src: diff.beforeImage,
        alt: `${diff.path} (before)`,
        loading: 'lazy',
      }),
    )
    grid.append(pane)
  }

  if (diff.afterImage) {
    const pane = el('div', { class: 'git-image-diff-pane' })
    pane.append(
      el('div', { class: 'git-image-diff-label' }, 'After'),
      el('img', {
        class: 'git-image-diff-img',
        src: diff.afterImage,
        alt: `${diff.path} (after)`,
        loading: 'lazy',
      }),
    )
    grid.append(pane)
  }

  if (!diff.beforeImage && !diff.afterImage) {
    grid.append(el('div', { class: 'panel-empty' }, 'Could not load image'))
  }

  container.append(grid)
}
