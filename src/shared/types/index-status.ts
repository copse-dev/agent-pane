/**
 * Workspace indexing status surfaced to the renderer (footer indicator).
 *
 * Two components are tracked independently: the in-memory file-path index
 * (fast — seconds) and the semantic symbol index (gortex/vera — can run for
 * minutes on a cold repo, #517). `building` means at least one build/update
 * pass is currently running for that component.
 *
 * `limited` / `skipped` are scale-guard outcomes (#795): text/regex search
 * stays available while semantic indexing (and recursive watching) refuse to
 * start unbounded work on oversized umbrella workspaces. They are not errors.
 */
export type IndexPhase =
  'idle' | 'building' | 'ready' | 'error' | 'unavailable' | 'limited' | 'skipped'

export interface IndexComponentStatus {
  phase: IndexPhase
  /** Epoch ms when the oldest still-running build started. Present while `building`. */
  startedAt?: number
  /** Human-readable scale-guard / skip reason. Present for `limited` / `skipped`. */
  reason?: string
}

export interface WorkspaceIndexStatus {
  fileIndex: IndexComponentStatus
  semantic: IndexComponentStatus
}
