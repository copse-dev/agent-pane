import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { openWorkspaceFile } from '../controller/files.ts'
import { showErrorToast } from '../views/toast.ts'

const FILE_REFERENCE_RE =
  /(^|[^A-Za-z0-9_./-])((?:\.\/)?(?:[A-Za-z0-9_@+$.-]+\/)+[A-Za-z0-9_@+$.-]+|[A-Za-z0-9_@+$-]+\.[A-Za-z0-9][A-Za-z0-9.-]{0,15}|Dockerfile|Makefile)(?=$|[^A-Za-z0-9_./-])/g

const SKIP_SELECTOR = 'a, button, textarea, select, pre, svg, .mermaid-diagram'
const TREE_WALKER_SHOW_TEXT = 4

interface FileReferenceMatch {
  candidate: string
  start: number
  end: number
}

function fileReferenceMatches(text: string): FileReferenceMatch[] {
  const matches: FileReferenceMatch[] = []
  FILE_REFERENCE_RE.lastIndex = 0
  for (let match = FILE_REFERENCE_RE.exec(text); match; match = FILE_REFERENCE_RE.exec(text)) {
    const prefix = match[1] ?? ''
    let candidate = match[2]
    if (!candidate) continue
    const start = match.index + prefix.length
    let end = start + candidate.length
    while (/[.,;:!?]$/.test(candidate)) {
      candidate = candidate.slice(0, -1)
      end--
    }
    if (candidate === '') continue
    matches.push({ candidate, start, end })
  }
  return matches
}

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
  resolutions: ReadonlyMap<string, string>,
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
    const path = resolutions.get(match.candidate)!
    const link = document.createElement('a')
    link.href = '#'
    link.className = 'file-reference-link'
    link.dataset.fileReferencePath = path
    link.title = path
    link.textContent = match.candidate
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

  const resolved = await api.index.resolveFileReferences(candidates)
  if (resolved.length === 0) return

  const resolutions = new Map(resolved.map(({ candidate, path }) => [candidate, path]))
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
    void openWorkspaceFile(store, api, path).catch((error) => {
      showErrorToast(`Failed to open ${path}`, error)
    })
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}
