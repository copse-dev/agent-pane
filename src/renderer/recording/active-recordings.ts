/**
 * Recordings in progress, for the composer's live chip.
 *
 * A pane owns its recording; the composer only shows that one is running and
 * offers a second Stop. Keeping this a tiny registry rather than a store field
 * means a recording never becomes persisted thread state — it is either running
 * or it has already turned into an ordinary video attachment.
 */

export interface ActiveRecording {
  id: string
  /** What is being recorded, e.g. "Desktop — build-box.local" or "Tab — localhost:5173". */
  label: string
  /** `performance.now()` at start, so the chip counts up from the same clock as the pane. */
  startedAt: number
  stop(): void
}

type Listener = (recordings: readonly ActiveRecording[]) => void

const active = new Map<string, ActiveRecording>()
const listeners = new Set<Listener>()

function emit(): void {
  const snapshot = [...active.values()]
  for (const listener of listeners) listener(snapshot)
}

/** Register a running recording; the returned function removes it. */
export function addActiveRecording(recording: ActiveRecording): () => void {
  active.set(recording.id, recording)
  emit()
  return () => {
    if (active.get(recording.id) !== recording) return
    active.delete(recording.id)
    emit()
  }
}

/** Called immediately with the current set, then on every change. */
export function subscribeActiveRecordings(listener: Listener): () => void {
  listeners.add(listener)
  listener([...active.values()])
  return () => {
    listeners.delete(listener)
  }
}

/** `m:ss`, the form both the pane pill and the composer chip show. */
export function formatRecordingClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`
}
