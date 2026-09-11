import { randomUUID } from 'node:crypto'
import type {
  SimulatorDesktopConnection,
  SimulatorDesktopInput,
} from '@shared/types/simulator-desktop.ts'
import {
  SIMULATOR_DESKTOP_FRAME_CHANNEL,
  SIMULATOR_DESKTOP_STATUS_CHANNEL,
  type SimulatorDesktopOwner,
} from '../simulator-desktop/simulator-desktop-service.ts'
import { discoverAndroidEndpoints } from './android-discovery.ts'
import { AndroidController } from './android-controller.ts'

interface PendingInput {
  input: SimulatorDesktopInput
  done: Promise<void>
}

interface Session {
  connection: SimulatorDesktopConnection
  owner: SimulatorDesktopOwner
  controller: AndroidController
  timer: NodeJS.Timeout | null
  inputQueue: Promise<void>
  pendingInputs: number
  pendingMove: PendingInput | null
  started: boolean
}

export class AndroidDesktopService {
  private readonly sessions = new Map<string, Session>()
  private readonly discover: typeof discoverAndroidEndpoints

  constructor(discover = discoverAndroidEndpoints) {
    this.discover = discover
  }

  async listDevices(): Promise<SimulatorDesktopConnection['device'][]> {
    return (await this.discover()).map((endpoint) => endpoint.device)
  }

  hasConnection(id: string): boolean {
    return this.sessions.has(id)
  }

  async open(udid: string, owner: SimulatorDesktopOwner): Promise<SimulatorDesktopConnection> {
    const endpoint = (await this.discover()).find((entry) => entry.device.udid === udid)
    if (!endpoint) throw new Error('That Android emulator is no longer running. Refresh devices.')
    if (owner.isDestroyed()) throw new Error('Desktop window closed')
    if ([...this.sessions.values()].some((session) => session.connection.device.udid === udid)) {
      throw new Error('That Android emulator is already open in a Desktop tab')
    }
    const controller = new AndroidController(endpoint)
    const connection: SimulatorDesktopConnection = {
      id: randomUUID(),
      device: endpoint.device,
      status: 'connecting',
    }
    const session: Session = {
      connection,
      owner,
      controller,
      timer: null,
      inputQueue: Promise.resolve(),
      pendingInputs: 0,
      pendingMove: null,
      started: false,
    }
    this.sessions.set(connection.id, session)
    // Also bounds open-without-start when a renderer disappears between the IPC calls.
    session.timer = setTimeout(() => {
      this.fail(
        session,
        'No Android display frame arrived within 20 seconds. Check emulator startup and reconnect.',
      )
    }, 20_000)
    session.timer.unref()
    return connection
  }

  private owned(id: string, ownerId: number): Session {
    const session = this.sessions.get(id)
    if (!session || session.owner.id !== ownerId)
      throw new Error('Android Desktop connection not found')
    return session
  }

  start(id: string, ownerId: number): void {
    const session = this.owned(id, ownerId)
    if (session.started) return
    session.started = true
    session.controller.start(
      (frame) => {
        if (!this.sessions.has(id)) return
        if (session.owner.isDestroyed()) {
          void this.close(id, ownerId)
          return
        }
        if (session.timer) {
          clearTimeout(session.timer)
          session.timer = null
        }
        if (session.connection.status !== 'connected') {
          session.connection.status = 'connected'
          session.owner.send(SIMULATOR_DESKTOP_STATUS_CHANNEL, { id, status: 'connected' })
        }
        session.owner.send(SIMULATOR_DESKTOP_FRAME_CHANNEL, {
          id,
          bytes: frame.bytes,
          mimeType: 'image/png',
          pixelWidth: frame.width,
          pixelHeight: frame.height,
        })
      },
      (error) => {
        this.fail(session, error.message)
      },
    )
  }

  sendInput(id: string, ownerId: number, input: SimulatorDesktopInput): Promise<void> {
    const session = this.owned(id, ownerId)
    const moving = input.type === 'touch' && input.phase === 'move'
    if (moving && session.pendingMove) {
      session.pendingMove.input = input
      return session.pendingMove.done
    }
    // Collapse pointer motion between hard events, never across a release/key.
    if (!moving) session.pendingMove = null
    if (session.pendingInputs >= 64) {
      this.fail(session, 'Android input could not keep up. Reconnect to resume control.')
      return Promise.reject(new Error('Android input queue is full'))
    }
    session.pendingInputs++
    const pending: PendingInput = { input, done: Promise.resolve() }
    const operation = session.inputQueue.then(async () => {
      if (session.pendingMove === pending) session.pendingMove = null
      if (!this.sessions.has(id)) return
      await session.controller.input(pending.input)
    })
    session.inputQueue = operation
      .catch(() => {})
      .finally(() => {
        session.pendingInputs--
      })
    pending.done = operation.catch((error: unknown) => {
      this.fail(session, 'Android input failed. Reconnect to resume control.')
      throw error
    })
    if (moving) session.pendingMove = pending
    return pending.done
  }

  private fail(session: Session, detail: string): void {
    if (!this.sessions.has(session.connection.id)) return
    if (!session.owner.isDestroyed())
      session.owner.send(SIMULATOR_DESKTOP_STATUS_CHANNEL, {
        id: session.connection.id,
        status: 'error',
        detail,
      })
    void this.close(session.connection.id, session.owner.id, false)
  }

  async close(id: string, ownerId: number, notify = true): Promise<void> {
    if (!this.sessions.has(id)) return
    const session = this.owned(id, ownerId)
    this.sessions.delete(id)
    if (session.timer) clearTimeout(session.timer)
    await session.controller.close()
    if (notify && !session.owner.isDestroyed())
      session.owner.send(SIMULATOR_DESKTOP_STATUS_CHANNEL, { id, status: 'closed' })
  }

  async closeOwner(ownerId: number): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.owner.id === ownerId)
        .map((session) => this.close(session.connection.id, ownerId)),
    )
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) =>
        this.close(session.connection.id, session.owner.id),
      ),
    )
  }
}
