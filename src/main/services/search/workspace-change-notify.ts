/** Coalesce recursive watch bursts before they cross the Electron boundary. */
export const WORKING_TREE_NOTIFY_DEBOUNCE_MS = 500

type WorkspaceChangeSink = (root: string) => void

let sink: WorkspaceChangeSink | null = null
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/** Install the Electron-facing delivery boundary for recursive workspace changes. */
export function setWorkspaceChangeSink(next: WorkspaceChangeSink | null): void {
  sink = next
}

/**
 * Whether one recursive `fs.watch` filename should wake git UI.
 *
 * Publish ordinary working-tree paths — including ignored search trees such as
 * `node_modules/` or `dist/`, which can still be tracked git changes. Inside
 * `.git/`, only HEAD (checkout) and the index (stage) are git-status signals;
 * objects, logs, and lock files are noise and can loop through `git status`
 * rewriting `.git/index`.
 */
export function shouldPublishWorkingTreeChange(filename: string | null): boolean {
  if (filename === null) return true
  const segments = filename.split(/[/\\]/)
  const [first, second] = segments
  if (first !== '.git') return true
  return segments.length === 2 && (second === 'HEAD' || second === 'index')
}

/** Notify consumers without coupling the index watcher to Electron windows. */
export function notifyWorkspaceChanged(root: string): void {
  const existing = pending.get(root)
  if (existing) clearTimeout(existing)
  pending.set(
    root,
    setTimeout(() => {
      pending.delete(root)
      sink?.(root)
    }, WORKING_TREE_NOTIFY_DEBOUNCE_MS),
  )
}

/** Test hook — deliver every pending root immediately. */
export function flushWorkspaceChangeNotify(): void {
  for (const [root, timer] of [...pending]) {
    clearTimeout(timer)
    pending.delete(root)
    sink?.(root)
  }
}

/** Test hook — drop the sink and any armed timers. */
export function resetWorkspaceChangeNotifyForTest(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  sink = null
}
