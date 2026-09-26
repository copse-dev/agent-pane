import { parseGithubPrUrl, type GithubPrRef } from '@shared/git/github-pr-url.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { computeTooltipPosition } from '../dom/tooltip.ts'
import { cachedPrTitle, loadPrTitle, type CachedPrTitle } from './pr-title-cache.ts'

const HOVER_DELAY_MS = 220
let nextPreviewId = 0

function linkedPr(
  root: HTMLElement,
  target: EventTarget | null,
): { link: HTMLAnchorElement; ref: GithubPrRef } | null {
  if (!(target instanceof Element)) return null
  const link = target.closest<HTMLAnchorElement>('a[href]')
  if (!link || !root.contains(link)) return null
  if (link.dataset['workspaceLink'] || link.dataset['fileReferencePath']) return null
  const ref = parseGithubPrUrl(link.href)
  return ref ? { link, ref } : null
}

export function bindPrLinkPreviews(
  root: HTMLElement,
  gh: Pick<ApiClient['gh'], 'prDetails'> | undefined,
): () => void {
  if (!gh) return () => {}
  const github = gh

  let activeLink: HTMLAnchorElement | null = null
  let suppressedLink: HTMLAnchorElement | null = null
  let preview: HTMLElement | null = null
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let requestGen = 0
  let disposed = false

  const previewId = `pr-link-preview-${String(++nextPreviewId)}`

  function ensurePreview(): HTMLElement {
    if (preview) return preview
    const node = document.createElement('div')
    node.id = previewId
    node.className = 'pr-link-preview'
    node.setAttribute('role', 'tooltip')
    node.hidden = true
    document.body.append(node)
    preview = node
    return node
  }

  function position(): void {
    if (!activeLink || !preview || preview.hidden) return
    const anchor = activeLink.getBoundingClientRect()
    const tip = preview.getBoundingClientRect()
    const placed = computeTooltipPosition({
      anchor: { left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height },
      tip: { width: tip.width, height: tip.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      preferred: 'bottom',
      gap: 9,
      pad: 12,
    })
    preview.style.left = `${String(Math.round(placed.left))}px`
    preview.style.top = `${String(Math.round(placed.top))}px`
  }

  function describedBy(link: HTMLAnchorElement, add: boolean): void {
    const values = (link.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    const next = values.filter((value) => value !== previewId)
    if (add) next.push(previewId)
    if (next.length) link.setAttribute('aria-describedby', next.join(' '))
    else link.removeAttribute('aria-describedby')
  }

  function hide(): void {
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      hoverTimer = null
    }
    requestGen++
    if (activeLink) describedBy(activeLink, false)
    activeLink = null
    if (preview) preview.hidden = true
  }

  function show(ref: GithubPrRef, data: CachedPrTitle | null): void {
    if (!activeLink) return
    const node = ensurePreview()
    node.replaceChildren()

    const meta = document.createElement('div')
    meta.className = 'pr-link-preview-meta'
    meta.textContent = `Pull request #${String(ref.number)}`
    if (data?.isDraft) {
      const badge = document.createElement('span')
      badge.className = 'pr-link-preview-draft'
      badge.textContent = 'Draft'
      meta.append(badge)
    }
    const title = document.createElement('div')
    title.className = 'pr-link-preview-title'
    title.textContent = data?.title ?? 'Loading title…'
    if (!data) title.classList.add('is-loading')
    const repo = document.createElement('div')
    repo.className = 'pr-link-preview-repo'
    repo.textContent = `${ref.owner} / ${ref.repo}`
    node.append(meta, title, repo)
    node.hidden = false
    describedBy(activeLink, true)
    position()
  }

  function activate(link: HTMLAnchorElement, ref: GithubPrRef, immediate: boolean): void {
    if (activeLink === link) return
    hide()
    activeLink = link
    const cached = cachedPrTitle(ref)
    if (cached) {
      show(ref, cached)
      return
    }
    const gen = requestGen
    const load = (): void => {
      hoverTimer = null
      if (disposed || activeLink !== link || gen !== requestGen) return
      show(ref, null)
      void loadPrTitle(ref, github)
        .then((title) => {
          if (disposed || activeLink !== link || gen !== requestGen) return
          if (title) show(ref, title)
          else hide()
        })
        .catch(() => {
          if (activeLink === link && gen === requestGen) hide()
        })
    }
    if (immediate) load()
    else hoverTimer = setTimeout(load, HOVER_DELAY_MS)
  }

  const onPointerOver = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    const found = linkedPr(root, event.target)
    if (found && found.link !== suppressedLink) activate(found.link, found.ref, false)
  }
  const onPointerOut = (event: PointerEvent): void => {
    const target = event.target
    const next = event.relatedTarget
    if (!(target instanceof Node) || !activeLink || !activeLink.contains(target)) return
    if (next instanceof Node && activeLink.contains(next)) return
    hide()
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (
      suppressedLink &&
      !(event.target instanceof Node && suppressedLink.contains(event.target))
    ) {
      suppressedLink = null
    }
  }
  const onFocusIn = (event: FocusEvent): void => {
    const found = linkedPr(root, event.target)
    if (found && found.link !== suppressedLink) activate(found.link, found.ref, true)
  }
  const onFocusOut = (event: FocusEvent): void => {
    if (activeLink === event.target) hide()
  }
  const onPointerDown = (event: PointerEvent): void => {
    suppressedLink = linkedPr(root, event.target)?.link ?? null
    hide()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') hide()
  }

  root.addEventListener('pointerover', onPointerOver)
  root.addEventListener('pointerout', onPointerOut)
  root.addEventListener('focusin', onFocusIn)
  root.addEventListener('focusout', onFocusOut)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('scroll', hide, true)
  window.addEventListener('resize', position)

  return () => {
    disposed = true
    hide()
    root.removeEventListener('pointerover', onPointerOver)
    root.removeEventListener('pointerout', onPointerOut)
    root.removeEventListener('focusin', onFocusIn)
    root.removeEventListener('focusout', onFocusOut)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('pointermove', onPointerMove, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('scroll', hide, true)
    window.removeEventListener('resize', position)
    preview?.remove()
  }
}
