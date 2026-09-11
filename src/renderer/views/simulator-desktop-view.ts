import type {
  SimulatorDesktopFrame,
  SimulatorDesktopInput,
} from '@shared/types/simulator-desktop.ts'
import { el } from '../dom/helpers.ts'

export interface SimulatorDesktopView {
  canvas: HTMLCanvasElement
  frame(frame: SimulatorDesktopFrame): void
  setControlEnabled(enabled: boolean): void
  focus(): void
  cleanup(): void
}

interface SimulatorDesktopViewOptions {
  connectionId: string
  screenLabel?: string
  sendInput(input: SimulatorDesktopInput): Promise<void>
  onFirstFrame(): void
  onInputError(error: unknown): void
}

function keyUsage(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 65 + 4
  if (/^Digit[1-9]$/.test(code)) return Number(code.at(-1)) + 29
  if (code === 'Digit0') return 39
  const usages: Readonly<Record<string, number>> = {
    Enter: 40,
    Escape: 41,
    Backspace: 42,
    Tab: 43,
    Space: 44,
    Minus: 45,
    Equal: 46,
    BracketLeft: 47,
    BracketRight: 48,
    Backslash: 49,
    Semicolon: 51,
    Quote: 52,
    Backquote: 53,
    Comma: 54,
    Period: 55,
    Slash: 56,
    CapsLock: 57,
    ArrowRight: 79,
    ArrowLeft: 80,
    ArrowDown: 81,
    ArrowUp: 82,
  }
  return usages[code] ?? null
}

function modifierUsages(event: KeyboardEvent): number[] {
  const usages: number[] = []
  if (event.ctrlKey) usages.push(224)
  if (event.shiftKey) usages.push(225)
  if (event.altKey) usages.push(226)
  if (event.metaKey) usages.push(227)
  return usages
}

export function createSimulatorDesktopView(
  options: SimulatorDesktopViewOptions,
): SimulatorDesktopView {
  const canvas = el('canvas', {
    class: 'simulator-desktop-canvas',
    'aria-label': options.screenLabel ?? 'iOS Simulator screen',
    tabindex: '0',
  })
  const context = canvas.getContext('2d')
  let controlEnabled = false
  const lifecycle = new AbortController()
  const isClosed = (): boolean => lifecycle.signal.aborted
  let pointerId: number | null = null
  let lastPoint = { x: 0, y: 0 }
  let firstFrame = true
  let decoding = false
  let pendingFrame: SimulatorDesktopFrame | null = null

  const send = (input: SimulatorDesktopInput): void => {
    void options.sendInput(input).catch((error: unknown) => {
      options.onInputError(error)
    })
  }

  const point = (event: PointerEvent): { x: number; y: number } => {
    const bounds = canvas.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    }
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!controlEnabled || event.button !== 0 || pointerId !== null) return
    event.preventDefault()
    pointerId = event.pointerId
    canvas.setPointerCapture(event.pointerId)
    lastPoint = point(event)
    send({ type: 'touch', phase: 'down', ...lastPoint })
  }
  const onPointerMove = (event: PointerEvent): void => {
    if (!controlEnabled || pointerId !== event.pointerId) return
    event.preventDefault()
    lastPoint = point(event)
    send({ type: 'touch', phase: 'move', ...lastPoint })
  }
  const releasePointer = (): void => {
    if (pointerId === null) return
    const released = pointerId
    pointerId = null
    send({ type: 'touch', phase: 'up', ...lastPoint })
    if (canvas.hasPointerCapture(released)) canvas.releasePointerCapture(released)
  }
  const finishPointer = (event: PointerEvent): void => {
    if (!controlEnabled || pointerId !== event.pointerId) return
    event.preventDefault()
    lastPoint = point(event)
    releasePointer()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!controlEnabled || event.repeat) return
    const usage = keyUsage(event.code)
    if (usage === null) return
    event.preventDefault()
    send({ type: 'key-tap', usage, modifiers: modifierUsages(event) })
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', finishPointer)
  canvas.addEventListener('pointercancel', finishPointer)
  canvas.addEventListener('lostpointercapture', releasePointer)
  canvas.addEventListener('blur', releasePointer)
  canvas.addEventListener('keydown', onKeyDown)

  const decodePendingFrame = async (): Promise<void> => {
    if (decoding || isClosed() || !context) return
    const frame = pendingFrame
    if (!frame) return
    pendingFrame = null
    decoding = true
    try {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(frame.bytes)], { type: frame.mimeType }),
      )
      if (isClosed()) {
        bitmap.close()
        return
      }
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
      }
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      if (firstFrame) {
        firstFrame = false
        options.onFirstFrame()
      }
    } finally {
      decoding = false
      queueMicrotask(() => {
        if (pendingFrame) void decodePendingFrame()
      })
    }
  }

  return {
    canvas,
    frame: (frame): void => {
      if (frame.id !== options.connectionId || isClosed()) return
      pendingFrame = frame
      void decodePendingFrame()
    },
    setControlEnabled: (enabled): void => {
      if (!enabled) releasePointer()
      controlEnabled = enabled
    },
    focus: (): void => {
      canvas.focus({ preventScroll: true })
    },
    cleanup: (): void => {
      releasePointer()
      lifecycle.abort()
      pendingFrame = null
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', finishPointer)
      canvas.removeEventListener('pointercancel', finishPointer)
      canvas.removeEventListener('lostpointercapture', releasePointer)
      canvas.removeEventListener('blur', releasePointer)
      canvas.removeEventListener('keydown', onKeyDown)
    },
  }
}

export const simulatorDesktopViewInternals = { keyUsage, modifierUsages }
