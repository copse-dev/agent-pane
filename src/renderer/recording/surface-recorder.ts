import { getPromptAttachmentHandlers } from '../attachments/prompt-attachments.ts'
import { el } from '../dom/helpers.ts'
import { showErrorToast, showToast } from '../views/toast.ts'
import { addActiveRecording, formatRecordingClock } from './active-recordings.ts'
import {
  RECORDING_MAX_DURATION_MS,
  startCanvasRecording,
  type CanvasRecording,
  type RecordingResult,
  type RecordingStopReason,
} from './canvas-recorder.ts'

/** A canvas showing the surface, plus whatever has to be torn down when recording ends. */
export interface RecordingCapture {
  canvas: HTMLCanvasElement
  dispose(): void
}

export interface SurfaceRecorderOptions {
  /** Short source name for the chip and the file: a machine, device, or page. */
  sourceLabel(): string
  /** Prefix naming the kind of surface: "Desktop", "Simulator", "Tab". */
  sourceKind(): string
  /** Resolve the canvas to record. Throwing refuses the start with that message. */
  openCapture(): Promise<RecordingCapture>
  /** Called whenever recording starts or stops, so the pane can restyle its own controls. */
  onChange?(recording: boolean): void
}

export interface SurfaceRecorder {
  /** Live pill — dot, elapsed / limit, Stop. Hidden while idle; the pane places it. */
  readonly indicator: HTMLElement
  isRecording(): boolean
  toggle(): void
  /** Stop and attach whatever was recorded. No-op while idle. */
  stop(reason?: RecordingStopReason): void
  dispose(): void
}

const MIN_KEPT_RECORDING_MS = 500

const STOP_NOTICES: Partial<Record<RecordingStopReason, string>> = {
  'duration-limit': `Recording stopped at the ${formatRecordingClock(RECORDING_MAX_DURATION_MS)} limit and was added to the thread.`,
  'size-limit': 'Recording stopped at the size limit and was added to the thread.',
  'source-ended': 'The connection ended. The recording up to that point was added to the thread.',
}

function fileStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

let nextRecordingId = 0

/**
 * Record/Stop for one pane surface. The pane supplies the canvas and its own
 * button; this owns the recording, the live pill, the composer's live chip, and
 * turning the finished WebM into an ordinary video attachment.
 */
export function createSurfaceRecorder(options: SurfaceRecorderOptions): SurfaceRecorder {
  const clock = el('span', { class: 'recording-indicator-clock' })
  const stopButton = el(
    'button',
    { type: 'button', class: 'recording-indicator-stop', 'aria-label': 'Stop recording' },
    el('span', { class: 'recording-indicator-stop-glyph', 'aria-hidden': 'true' }),
    'Stop',
  )
  const indicator = el(
    'div',
    { class: 'recording-indicator', role: 'status', hidden: true },
    el('span', { class: 'recording-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'recording-indicator-label' }, 'Recording'),
    clock,
    stopButton,
  )

  let session: {
    recording: CanvasRecording
    capture: RecordingCapture
    label: string
    startedAt: Date
    tick: number
    unregister: () => void
  } | null = null
  let starting = false
  let disposed = false
  // Read through a function: `disposed` flips across an await, which narrowing cannot see.
  const isDisposed = (): boolean => disposed

  function renderClock(): void {
    if (!session) return
    clock.textContent = `${formatRecordingClock(session.recording.elapsedMs())} / ${formatRecordingClock(RECORDING_MAX_DURATION_MS)}`
  }

  function setRecordingUi(recording: boolean): void {
    indicator.hidden = !recording
    options.onChange?.(recording)
  }

  async function start(): Promise<void> {
    if (session || starting || disposed) return
    if (!getPromptAttachmentHandlers()) {
      showToast('Open a thread before recording.', { variant: 'error' })
      return
    }
    starting = true
    let capture: RecordingCapture | null = null
    try {
      capture = await options.openCapture()
      if (isDisposed()) {
        capture.dispose()
        return
      }
      const recording = startCanvasRecording(capture.canvas)
      const label = `${options.sourceKind()} — ${options.sourceLabel()}`
      const id = `recording-${String(++nextRecordingId)}`
      const current = {
        recording,
        capture,
        label,
        startedAt: new Date(),
        tick: window.setInterval(renderClock, 250),
        unregister: addActiveRecording({
          id,
          label,
          startedAt: performance.now() - recording.elapsedMs(),
          stop: () => {
            stop('user')
          },
        }),
      }
      session = current
      renderClock()
      setRecordingUi(true)
      // Limits stop the recorder from inside; the pane hears about it here.
      void recording.finished.then(
        (result) => finish(current, result),
        (error: unknown) => {
          teardown(current)
          showErrorToast('Recording failed', error)
        },
      )
    } catch (error) {
      capture?.dispose()
      showErrorToast('Could not start recording', error)
    } finally {
      starting = false
    }
  }

  function teardown(current: NonNullable<typeof session>): void {
    if (session !== current) return
    session = null
    window.clearInterval(current.tick)
    current.unregister()
    current.capture.dispose()
    setRecordingUi(false)
  }

  async function finish(
    current: NonNullable<typeof session>,
    result: RecordingResult,
  ): Promise<void> {
    teardown(current)
    if (result.blob.size === 0 || result.durationMs < MIN_KEPT_RECORDING_MS) {
      showToast('The recording was too short to keep.')
      return
    }
    const handlers = getPromptAttachmentHandlers()
    if (!handlers) {
      showToast('Open a thread to keep the recording.', { variant: 'error' })
      return
    }
    await handlers.attachVideo({
      name: `Recording — ${current.label} — ${fileStamp(current.startedAt)}.webm`,
      mimeType: 'video/webm',
      bytes: await result.blob.arrayBuffer(),
    })
    const notice = STOP_NOTICES[result.reason]
    if (notice) showToast(notice)
  }

  function stop(reason: RecordingStopReason = 'user'): void {
    if (session) void session.recording.stop(reason)
  }

  stopButton.addEventListener('click', () => {
    stop('user')
  })

  return {
    indicator,
    isRecording: () => session !== null,
    toggle: (): void => {
      if (session) stop('user')
      else void start()
    },
    stop,
    dispose: (): void => {
      disposed = true
      stop('source-ended')
    },
  }
}
