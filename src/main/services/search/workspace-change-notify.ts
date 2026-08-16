type WorkspaceChangeSink = (root: string) => void

let sink: WorkspaceChangeSink | null = null

/** Install the Electron-facing delivery boundary for recursive workspace changes. */
export function setWorkspaceChangeSink(next: WorkspaceChangeSink | null): void {
  sink = next
}

/** Notify consumers without coupling the index watcher to Electron windows. */
export function notifyWorkspaceChanged(root: string): void {
  sink?.(root)
}
