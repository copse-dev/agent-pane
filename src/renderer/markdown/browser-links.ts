import type { AppStore } from '@shared/store/store.ts'
import { openBrowserUrl } from '../controller/panels.ts'

function linkHttpHref(link: HTMLAnchorElement): string | null {
  const href = link.href
  if (!/^https?:\/\//i.test(href)) return null
  return href
}

export function bindBrowserLinkClicks(root: HTMLElement, store: AppStore): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target
    if (!target || typeof (target as Element).closest !== 'function') return
    const link = (target as Element).closest<HTMLAnchorElement>('a[href]')
    if (!link || !root.contains(link)) return
    if (link.dataset.fileReferencePath) return

    const href = linkHttpHref(link)
    if (!href) return

    event.preventDefault()
    event.stopPropagation()
    openBrowserUrl(store, href)
  }

  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}
