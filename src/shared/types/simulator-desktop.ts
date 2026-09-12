export interface SimulatorDesktopDevice {
  udid: string
  name: string
  runtime: string
}

export type SimulatorDesktopStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SimulatorDesktopConnection {
  id: string
  device: SimulatorDesktopDevice
  status: SimulatorDesktopStatus
}

export interface SimulatorDesktopStatusEvent {
  id: string
  status: SimulatorDesktopStatus
  detail?: string
}

export interface SimulatorDesktopFrame {
  id: string
  bytes: Uint8Array
  mimeType: 'image/jpeg' | 'image/png' | 'image/svg+xml'
  pixelWidth: number
  pixelHeight: number
}

export type SimulatorDesktopInput =
  | {
      type: 'touch'
      phase: 'down' | 'move' | 'up'
      x: number
      y: number
    }
  | {
      type: 'key-tap'
      usage: number
      modifiers?: number[] | undefined
    }
  | {
      type: 'button-tap'
      name: 'home' | 'lock' | 'side' | 'siri'
    }
