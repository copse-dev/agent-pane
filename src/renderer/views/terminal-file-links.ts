import type { Terminal, ILink, ILinkProvider, IBufferRange } from '@xterm/xterm'
import type { AppStore } from '@shared/store/store.ts'
import { fileReferenceMatches } from '@shared/fs/file-reference.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { activateWorkspaceReference } from '../controller/files.ts'
import { showErrorToast } from './toast.ts'

const RESOLVE_DEBOUNCE_MS = 250

export interface TerminalFileLinks {
  /** Re-scan the viewport and resolve newly-seen file references (debounced). */
  refresh(): void
  dispose(): void
}

/**
 * Reads the visible rows of an xterm buffer, ANSI-free, and collects every
 * file-path-shaped token. Wide (CJK) glyphs are rare in paths, so byte/cell
 * offsets are treated as 1:1 with string offsets.
 */
function collectVisibleCandidates(term: Terminal): string[] {
  const buf = term.buffer.active
  const top = buf.viewportY
  const bottom = Math.min(buf.length, top + term.rows)
  const out = new Set<string>()
  for (let i = top; i < bottom; i++) {
    const line = buf.getLine(i)
    if (!line) continue
    for (const match of fileReferenceMatches(line.translateToString(true))) {
      out.add(match.candidate)
    }
  }
  return [...out]
}

/**
 * Makes workspace file paths printed in a terminal cmd/ctrl-clickable, opening
 * them in the file viewer — the terminal counterpart of the chat file linker.
 *
 * Detection and the resolve-against-the-index gate are shared with chat
 * (`@shared/fs/file-reference.ts` + `api.index.resolveFileReferences`), so only
 * paths that exist in the workspace become links. Resolution is async, so the
 * provider serves links from a cache that `refresh()` keeps warm from terminal
 * output; the synchronous `provideLinks` never blocks on IPC.
 *
 * Paths are resolved relative to the workspace root (the shell's start cwd). A
 * `:line` / `:line:col` suffix navigates to that location. See
 * `docs/plans/terminal-file-links-improvements.md` for cwd-aware resolution.
 */
export function installTerminalFileLinks(
  term: Terminal,
  store: AppStore,
  api: ApiClient,
): TerminalFileLinks {
  const resolved = new Map<string, { path: string; kind: 'file' | 'directory' }>()
  let timer: ReturnType<typeof setTimeout> | null = null

  async function resolveNow(): Promise<void> {
    if (!store.getState().workspaceRoot) return
    const unknown = collectVisibleCandidates(term).filter((c) => !resolved.has(c))
    if (unknown.length === 0) return
    try {
      const list = (await api.index.resolveFileReferences(unknown)) ?? []
      for (const { candidate, path, kind } of list) resolved.set(candidate, { path, kind })
    } catch {
      // Leave candidates unresolved; the next refresh retries them.
    }
  }

  function refresh(): void {
    if (timer != null) return
    timer = setTimeout(() => {
      timer = null
      void resolveNow()
    }, RESOLVE_DEBOUNCE_MS)
  }

  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1)
      if (!line) {
        callback(undefined)
        return
      }
      const text = line.translateToString(true)
      const links: ILink[] = []
      for (const match of fileReferenceMatches(text)) {
        const target = resolved.get(match.candidate)
        if (!target) continue
        const { path, kind } = target
        const range: IBufferRange = {
          start: { x: match.start + 1, y: bufferLineNumber },
          end: { x: match.end, y: bufferLineNumber },
        }
        const reveal =
          match.line != null
            ? { line: match.line, ...(match.column != null ? { column: match.column } : {}) }
            : undefined
        links.push({
          range,
          text: match.text,
          activate: (event) => {
            // Match IDE/terminal convention: only open on cmd/ctrl-click so
            // plain clicks still place the cursor and start text selection.
            if (!event.metaKey && !event.ctrlKey) return
            void activateWorkspaceReference(store, api, path, kind, reveal).catch((error) => {
              showErrorToast(`Failed to open ${path}`, error)
            })
          },
          decorations: { pointerCursor: true, underline: true },
        })
      }
      callback(links.length > 0 ? links : undefined)
    },
  }

  const disposable = term.registerLinkProvider(provider)

  return {
    refresh,
    dispose() {
      if (timer != null) clearTimeout(timer)
      timer = null
      disposable.dispose()
    },
  }
}
