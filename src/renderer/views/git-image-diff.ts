import type { GitFileDiff } from '@shared/types/git.ts'
import { attachImageExpand } from '../attachments/image-expand.ts'
import { clear, el } from '../dom/helpers.ts'

export function isImageDiff(diff: GitFileDiff): boolean {
  return diff.beforeImage != null || diff.afterImage != null
}

interface RenderedImageDiff {
  grid: HTMLElement
  path: string
  beforeImage: string | null
  afterImage: string | null
}

const renderedImageDiffs = new WeakMap<HTMLElement, RenderedImageDiff>()

function imagePane(label: string, src: string, alt: string): HTMLElement {
  const img = el('img', { class: 'git-image-diff-img', src, alt, loading: 'lazy' })
  attachImageExpand(img, alt)
  const pane = el('div', { class: 'git-image-diff-pane' })
  pane.append(el('div', { class: 'git-image-diff-label' }, label), img)
  return pane
}

/**
 * Render a before/after image diff into `container`.
 *
 * The Changes pane re-selects the open file on every refresh, and a refresh
 * follows any working-tree event (a turn ending, a sandbox placeholder coming
 * or going). Replacing the thumbnails each time moved focus to the page body
 * whenever one was focused, including just after an image preview had returned
 * focus to it. So an unchanged diff keeps its nodes, and a changed one moves
 * focus to the thumbnail for the same side.
 */
export function renderImageDiff(container: HTMLElement, diff: GitFileDiff): void {
  const beforeImage = diff.beforeImage ?? null
  const afterImage = diff.afterImage ?? null
  const current = renderedImageDiffs.get(container)
  if (
    current?.grid.parentNode === container &&
    current.path === diff.path &&
    current.beforeImage === beforeImage &&
    current.afterImage === afterImage
  ) {
    return
  }

  const active = document.activeElement
  const focusedAlt = active && container.contains(active) ? active.getAttribute('alt') : null

  clear(container)
  const grid = el('div', { class: 'git-image-diff' })
  if (beforeImage) grid.append(imagePane('Before', beforeImage, `${diff.path} (before)`))
  if (afterImage) grid.append(imagePane('After', afterImage, `${diff.path} (after)`))
  if (!beforeImage && !afterImage) {
    grid.append(el('div', { class: 'panel-empty' }, 'Could not load image'))
  }
  container.append(grid)
  renderedImageDiffs.set(container, { grid, path: diff.path, beforeImage, afterImage })

  if (focusedAlt === null) return
  for (const img of grid.querySelectorAll<HTMLImageElement>('.git-image-diff-img')) {
    if (img.alt === focusedAlt) {
      img.focus({ preventScroll: true })
      return
    }
  }
}
