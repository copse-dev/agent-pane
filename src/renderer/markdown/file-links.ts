import type { AppStore } from '@shared/store/store.ts'
import { fileReferenceMatches } from '@shared/fs/file-reference.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { activateWorkspaceReference } from '../controller/files.ts'
import { showErrorToast } from '../views/toast.ts'

const SKIP_SELECTOR = 'a, button, textarea, select, pre, svg, .mermaid-diagram'
const TREE_WALKER_SHOW_TEXT = 4

function shouldScanTextNode(node: Text, root: HTMLElement): boolean {
  const parent = node.parentElement
  return Boolean(parent && root.contains(parent) && !parent.closest(SKIP_SELECTOR))
}

function textNodesToScan(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, TREE_WALKER_SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    if (shouldScanTextNode(textNode, root) && fileReferenceMatches(textNode.data).length > 0) {
      nodes.push(textNode)
    }
  }
  return nodes
}

export function findFileReferenceCandidates(root: HTMLElement): string[] {
  const candidates = new Set<string>()
  for (const node of textNodesToScan(root)) {
    for (const match of fileReferenceMatches(node.data)) {
      candidates.add(match.candidate)
    }
  }
  return [...candidates]
}

function replaceTextNodeReferences(
  node: Text,
  resolutions: ReadonlyMap<string, { path: string; kind: 'file' | 'directory' }>,
  root: HTMLElement,
): void {
  if (!node.parentNode || !shouldScanTextNode(node, root)) return
  const matches = fileReferenceMatches(node.data).filter((match) =>
    resolutions.has(match.candidate),
  )
  if (matches.length === 0) return

  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) {
      fragment.append(document.createTextNode(node.data.slice(cursor, match.start)))
    }
    const target = resolutions.get(match.candidate)!
    const { path, kind } = target
    const link = document.createElement('a')
    link.href = '#'
    link.className = 'file-reference-link'
    link.dataset.fileReferencePath = path
    link.dataset.fileReferenceKind = kind
    if (match.line != null) link.dataset.fileReferenceLine = String(match.line)
    if (match.column != null) link.dataset.fileReferenceColumn = String(match.column)
    link.title = match.line != null ? `${path}:${match.line}` : path
    link.textContent = match.text
    fragment.append(link)
    cursor = match.end
  }
  if (cursor < node.data.length) {
    fragment.append(document.createTextNode(node.data.slice(cursor)))
  }
  node.parentNode.replaceChild(fragment, node)
}

export async function annotateFileReferences(root: HTMLElement, api: ApiClient): Promise<void> {
  const candidates = findFileReferenceCandidates(root)
  if (candidates.length === 0) return

  const resolved = (await api.index.resolveFileReferences(candidates)) ?? []
  if (resolved.length === 0) return

  const resolutions = new Map(
    resolved.map(({ candidate, path, kind }) => [candidate, { path, kind }]),
  )
  for (const node of textNodesToScan(root)) {
    replaceTextNodeReferences(node, resolutions, root)
  }
}

export function bindFileReferenceClicks(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target
    if (!target || typeof (target as Element).closest !== 'function') return
    const link = (target as Element).closest<HTMLAnchorElement>('a[data-file-reference-path]')
    if (!link || !root.contains(link)) return

    event.preventDefault()
    event.stopPropagation()

    const path = link.dataset.fileReferencePath
    if (!path) return
    const kind = link.dataset.fileReferenceKind === 'directory' ? 'directory' : 'file'
    const line = link.dataset.fileReferenceLine
    const column = link.dataset.fileReferenceColumn
    const reveal = line
      ? { line: Number(line), ...(column ? { column: Number(column) } : {}) }
      : undefined
    void activateWorkspaceReference(store, api, path, kind, reveal).catch((error) => {
      showErrorToast(`Failed to open ${path}`, error)
    })
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}
