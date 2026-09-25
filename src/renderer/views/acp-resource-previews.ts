import type { AppStore } from '@shared/store/store.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import { isRasterImagePath } from '@shared/fs/image-path.ts'
import {
  localPathFromUri,
  normalizeWorkspacePath,
  workspaceRelativePath,
} from '@shared/fs/workspace-path.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { attachImageExpand } from '../attachments/image-expand.ts'
import { getActiveThreadOwner, type ActiveThreadOwner } from '../controller/active-thread-owner.ts'
import { el } from '../dom/helpers.ts'

/**
 * ACP resource links that name workspace files. Tool output and message content
 * render them as cards (see createAcpContentBlock); this module loads image
 * cards as previews, and lets a finished reply cite one with an ordinary
 * Markdown link, which opens the file or shows the image inline and hides the
 * earlier duplicate card.
 *
 * Cards and citations are matched by workspace-relative path, so `/repo/a.png`,
 * `file:///repo/a.png` and `a.png` are one resource.
 */

const RESOURCE_SELECTOR = '.acp-resource-link[data-workspace-resource-path], .acp-resource-image'
const REFERENCE_SELECTOR =
  '.msg-assistant .message-text:not(.is-streaming) [data-workspace-resource-reference]'

/** The checkout a thread's tools wrote to: its worktree, else the project root. */
export function acpWorkspaceRoot(store: AppStore): string | null {
  return getActiveThread(store)?.worktree?.path ?? store.getState().workspaceRoot
}

/** Show a workspace path relative to the checkout; anything else as given. */
export function workspaceDisplayPath(value: string, workspaceRoot: string | null): string {
  if (!workspaceRoot) return value
  const path = localPathFromUri(value)
  const relative = path === null ? null : workspaceRelativePath(path, workspaceRoot)
  if (relative === null) return value
  return relative || '.'
}

/** The workspace file a resource URI or link names, relative to the checkout. */
export function workspaceResourceFilePath(
  uri: string,
  workspaceRoot: string | null,
): string | null {
  if (!workspaceRoot) return null
  const path = localPathFromUri(uri)
  if (path === null) return null
  const relative = /^(?:\/|[a-z]:[\\/])/i.test(path)
    ? workspaceRelativePath(path, workspaceRoot)
    : normalizeWorkspacePath(path)
  if (!relative || relative.split('/').includes('..')) return null
  return relative
}

type ImageRead = { key: string; promise: Promise<string>; src?: string }

/** Enough for a screenful of previews without holding a long thread's images. */
const MAX_IMAGE_READS = 32
const imageReads = new Map<string, ImageRead>()

/**
 * Read a workspace image once per message. A card rebuilt by a later tool
 * update, and a reply citing it, reuse the read; a later message that writes
 * the same path again gets a fresh one.
 */
function readResourceImage(
  api: ApiClient,
  owner: ActiveThreadOwner,
  workspaceRoot: string,
  messageId: string,
  path: string,
): ImageRead {
  const key = [owner.projectId, owner.threadId, workspaceRoot, messageId, path].join('\0')
  const cached = imageReads.get(key)
  if (cached) {
    imageReads.delete(key)
    imageReads.set(key, cached)
    return cached
  }
  const read: ImageRead = {
    key,
    promise: api.fs.readImage(owner.projectId, owner.threadId, path),
  }
  imageReads.set(key, read)
  for (const oldest of imageReads.keys()) {
    if (imageReads.size <= MAX_IMAGE_READS) break
    imageReads.delete(oldest)
  }
  read.promise.then(
    (src) => {
      read.src = src
    },
    () => {
      forgetImageRead(read)
    },
  )
  return read
}

function forgetImageRead(read: ImageRead): void {
  if (imageReads.get(read.key) === read) imageReads.delete(read.key)
}

/** Apply a read now when it has already resolved, so re-renders never flicker. */
function whenImageRead(read: ImageRead, apply: (src: string) => void): void {
  if (read.src !== undefined) {
    apply(read.src)
    return
  }
  read.promise.then(apply, () => {
    // Missing, oversized, or disallowed files keep their readable link.
  })
}

function messageIdOf(node: Element): string {
  return node.closest<HTMLElement>('[data-message-id]')?.dataset['messageId'] ?? ''
}

/** Replace a loaded image card with a preview that keeps its link and details. */
function showCardImage(card: HTMLElement, src: string, read: ImageRead): void {
  const path = card.dataset['workspaceResourcePath'] ?? ''
  const uri = card.dataset['acpResourceUri'] ?? path
  const label = card.querySelector('.acp-resource-title')?.textContent ?? path
  const image = el('img', { class: 'tool-result-preview-image', src, alt: label, loading: 'lazy' })
  attachImageExpand(image, label)
  const details = Array.from(
    card.querySelectorAll('.acp-resource-description, .acp-resource-meta'),
    (node) => node.cloneNode(true),
  )
  const figure = el(
    'figure',
    {
      class: 'tool-result-preview acp-resource-image',
      title: card.title,
      'data-acp-resource-uri': uri,
      'data-workspace-resource-path': path,
    },
    image,
    el(
      'figcaption',
      { class: 'tool-result-preview-caption' },
      el(
        'a',
        { class: 'acp-resource-image-link', href: uri, 'data-workspace-resource-path': path },
        path,
      ),
    ),
    ...details,
  )
  image.addEventListener(
    'error',
    () => {
      forgetImageRead(read)
      if (!figure.isConnected) return
      card.hidden = figure.hidden
      figure.replaceWith(card)
    },
    { once: true },
  )
  figure.hidden = card.hidden
  card.replaceWith(figure)
}

/** Load image resource cards under `root` through the contained file-preview IPC. */
export function hydrateAcpResourceImages(root: HTMLElement, api: ApiClient, store: AppStore): void {
  const owner = getActiveThreadOwner(store)
  const workspaceRoot = acpWorkspaceRoot(store)
  if (!owner || !workspaceRoot) return
  for (const card of root.querySelectorAll<HTMLElement>(
    '.acp-resource-link[data-workspace-resource-path]:not([data-image-preview-requested])',
  )) {
    const path = card.dataset['workspaceResourcePath']
    if (!path || !isRasterImagePath(path)) continue
    card.dataset['imagePreviewRequested'] = 'true'
    const read = readResourceImage(api, owner, workspaceRoot, messageIdOf(card), path)
    whenImageRead(read, (src) => {
      if (!card.isConnected || !isCurrentOwner(store, owner, workspaceRoot)) return
      showCardImage(card, src, read)
    })
  }
}

function isCurrentOwner(store: AppStore, owner: ActiveThreadOwner, workspaceRoot: string): boolean {
  const current = getActiveThreadOwner(store)
  return (
    current?.projectId === owner.projectId &&
    current.threadId === owner.threadId &&
    acpWorkspaceRoot(store) === workspaceRoot
  )
}

/**
 * Keep a rebuilt block's cited resources hidden until the next reference pass,
 * so a tool or content update never flashes the duplicate back in.
 */
export function replaceAcpResourceBlock(current: HTMLElement, replacement: HTMLElement): void {
  const hidden = new Set<string>()
  for (const resource of current.querySelectorAll<HTMLElement>(RESOURCE_SELECTOR)) {
    const path = resource.dataset['workspaceResourcePath']
    if (path && resource.hidden) hidden.add(path)
  }
  for (const resource of replacement.querySelectorAll<HTMLElement>(RESOURCE_SELECTOR)) {
    const path = resource.dataset['workspaceResourcePath']
    if (path && hidden.has(path)) resource.hidden = true
  }
  current.replaceWith(replacement)
}

/** Position of each rendered message, so citations only reach back in time. */
function messageOrder(list: HTMLElement): (node: Element) => number {
  const order = new Map<Element, number>()
  list.querySelectorAll('[data-message-id]').forEach((message, index) => {
    order.set(message, index)
  })
  return (node) => {
    const message = node.closest('[data-message-id]')
    return message ? (order.get(message) ?? -1) : -1
  }
}

/**
 * Hide each resource a later (or the same) message cites, so the file shows
 * once, where the reply discusses it. A resource written again after the
 * citation stays visible.
 */
function syncResourceVisibility(list: HTMLElement): void {
  const indexOf = messageOrder(list)
  const latestReference = new Map<string, number>()
  for (const reference of list.querySelectorAll<HTMLElement>(REFERENCE_SELECTOR)) {
    const path = reference.dataset['workspaceResourcePath']
    if (!path) continue
    latestReference.set(path, Math.max(latestReference.get(path) ?? -1, indexOf(reference)))
  }
  for (const resource of list.querySelectorAll<HTMLElement>(RESOURCE_SELECTOR)) {
    const path = resource.dataset['workspaceResourcePath']
    if (!path) continue
    resource.hidden = (latestReference.get(path) ?? -1) >= indexOf(resource)
  }
}

type LinkTarget = { root: string; uri: string; path: string | null }
const linkTargets = new WeakMap<HTMLAnchorElement, LinkTarget>()

/** The decoded href a reply link cites, and the workspace file it names. */
function linkTarget(link: HTMLAnchorElement, workspaceRoot: string): LinkTarget {
  const cached = linkTargets.get(link)
  if (cached?.root === workspaceRoot) return cached
  const href = link.getAttribute('href') ?? ''
  let uri = href
  if (!/^file:/i.test(href)) {
    try {
      uri = decodeURI(href)
    } catch {
      // Preserve malformed escape sequences as literal path characters.
    }
  }
  const target = { root: workspaceRoot, uri, path: workspaceResourceFilePath(uri, workspaceRoot) }
  linkTargets.set(link, target)
  return target
}

/** The newest write of `path` in or before message `index`. */
function citedResource(
  entries: readonly { node: HTMLElement; index: number }[] | undefined,
  index: number,
): HTMLElement | null {
  if (!entries) return null
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry && entry.index <= index) return entry.node
  }
  return null
}

function showReferencedImage(
  link: HTMLAnchorElement,
  { uri, path }: { uri: string; path: string },
  src: string,
  read: ImageRead,
  list: HTMLElement,
): void {
  const label = link.textContent.trim() || path
  const image = el('img', { class: 'tool-result-preview-image', src, alt: label, loading: 'lazy' })
  attachImageExpand(image, label)
  const labelIsPath = label === uri || label === path
  const preview = el(
    'span',
    {
      class: 'tool-result-preview acp-referenced-image',
      title: uri,
      'data-workspace-resource-path': path,
      'data-workspace-resource-reference': 'true',
    },
    image,
    el('span', { class: 'tool-result-preview-caption' }, labelIsPath ? path : label),
    ...(labelIsPath ? [] : [el('code', { class: 'acp-referenced-image-path' }, path)]),
  )
  image.addEventListener(
    'error',
    () => {
      forgetImageRead(read)
      if (!preview.isConnected) return
      preview.replaceWith(link)
      syncResourceVisibility(list)
    },
    { once: true },
  )
  link.replaceWith(preview)
}

/**
 * Connect finished replies to the workspace resources they cite, then settle
 * which resource cards are duplicates. One pass over the transcript, safe to
 * repeat: streaming replies are left to their renderer until they finish.
 */
export function syncAcpResourceReferences(
  list: HTMLElement,
  api: ApiClient,
  store: AppStore,
): void {
  const owner = getActiveThreadOwner(store)
  const workspaceRoot = acpWorkspaceRoot(store)
  // Most transcripts have no resources: one short-circuiting scan, then out.
  if (!owner || !workspaceRoot || !list.querySelector(RESOURCE_SELECTOR)) return
  hydrateAcpResourceImages(list, api, store)
  // Hydration can swap cards for previews, so collect resources after it.
  const resources = list.querySelectorAll<HTMLElement>(RESOURCE_SELECTOR)
  const indexOf = messageOrder(list)
  const resourcesByPath = new Map<string, { node: HTMLElement; index: number }[]>()
  for (const node of resources) {
    const path = node.dataset['workspaceResourcePath']
    if (!path) continue
    const entries = resourcesByPath.get(path) ?? []
    entries.push({ node, index: indexOf(node) })
    resourcesByPath.set(path, entries)
  }

  for (const link of list.querySelectorAll<HTMLAnchorElement>(
    '.msg-assistant .message-text:not(.is-streaming) a[href]:not([data-workspace-resource-reference])',
  )) {
    const { uri, path } = linkTarget(link, workspaceRoot)
    if (!path) continue
    const resource = citedResource(resourcesByPath.get(path), indexOf(link))
    if (!resource) continue
    link.dataset['workspaceResourcePath'] = path
    if (!isRasterImagePath(path)) {
      link.dataset['workspaceResourceReference'] = 'true'
      continue
    }
    if (link.dataset['imageReferenceRequested']) continue
    link.dataset['imageReferenceRequested'] = 'true'
    const read = readResourceImage(api, owner, workspaceRoot, messageIdOf(resource), path)
    let settled = false
    whenImageRead(read, (src) => {
      if (!link.isConnected || !isCurrentOwner(store, owner, workspaceRoot)) return
      showReferencedImage(link, { uri, path }, src, read, list)
      // A synchronous preview is picked up by the visibility pass below.
      if (settled) syncResourceVisibility(list)
    })
    settled = true
  }
  syncResourceVisibility(list)
}
