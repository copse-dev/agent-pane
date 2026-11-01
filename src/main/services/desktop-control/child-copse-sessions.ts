import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import {
  getDesktopControlService,
  peekDesktopControlService,
  type DesktopApp,
} from './desktop-control-service.ts'

const PREFIX = 'child:'
const MAX_SESSION_MS = 30 * 60_000

export type ChildCopseControl = (stop: () => void) => Promise<() => void>
let controlWindow: ChildCopseControl | null = null

/** Installed only by the desktop entry point; headless agents cannot launch GUI sessions. */
export function setChildCopseControl(next: ChildCopseControl | null): void {
  controlWindow = next
}

export function isChildCopseTarget(value: string): boolean {
  return /^child:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

export interface ChildCopseBackend {
  start: (id: string, bundle: string, entry: string, profile: string) => Promise<DesktopApp>
  validate: (id: string) => Promise<DesktopApp>
  stop: (id: string) => Promise<void>
}

interface Session {
  id: string
  threadId: string
  timer: NodeJS.Timeout
  monitor: NodeJS.Timeout
  closeControl: () => void
}

/** Session authority never comes from a bundle id, title, PID, or child-provided file. */
export class ChildCopseSessions {
  private readonly sessions = new Map<string, Session>()
  private readonly launchGrants = new Set<string>()
  private generation = 0
  private pendingStarts = 0

  private readonly backend: ChildCopseBackend

  constructor(backend: ChildCopseBackend) {
    this.backend = backend
  }

  approveStart(threadId: string): void {
    this.launchGrants.add(threadId)
  }

  async start(
    threadId: string,
    bundle: string,
    entry: string,
    profile: string,
    showControl: (stop: () => void) => Promise<() => void>,
  ): Promise<string> {
    if (!this.launchGrants.delete(threadId)) throw new Error('Child launch requires approval.')
    if (this.sessions.size + this.pendingStarts >= 4)
      throw new Error('Stop an existing child session first (maximum four).')
    const generation = this.generation
    const id = randomUUID()
    this.pendingStarts++
    try {
      await this.backend.start(id, bundle, entry, profile)
    } catch (error) {
      // A lost or malformed reply must not leave a successfully launched child behind.
      await this.backend.stop(id).catch(() => undefined)
      throw error
    } finally {
      this.pendingStarts--
    }
    if (generation !== this.generation) {
      await this.backend.stop(id)
      throw new Error('Child launch was revoked.')
    }
    const target = PREFIX + id
    const stop = (): void => {
      void this.stop(target, threadId).catch(() => undefined)
    }
    const timer = setTimeout(stop, MAX_SESSION_MS)
    timer.unref()
    const monitor = setInterval(() => {
      void this.resolve(target, threadId).catch(stop)
    }, 1000)
    monitor.unref()
    const session: Session = { id, threadId, timer, monitor, closeControl: () => undefined }
    this.sessions.set(id, session)
    try {
      const closeControl = await showControl(stop)
      if (this.sessions.get(id) !== session) {
        closeControl()
        throw new Error('Child session stopped during launch.')
      }
      session.closeControl = closeControl
    } catch (error) {
      stop()
      throw error
    }
    return target
  }

  private owned(target: string, threadId: string): Session {
    const session = isChildCopseTarget(target)
      ? this.sessions.get(target.slice(PREFIX.length))
      : undefined
    if (!session || session.threadId !== threadId)
      throw new Error('No active child session owned by this thread.')
    return session
  }

  async resolve(target: string, threadId: string): Promise<DesktopApp> {
    const session = this.owned(target, threadId)
    try {
      const app = await this.backend.validate(session.id)
      if (this.owned(target, threadId) !== session) throw new Error('Child session changed.')
      return app
    } catch (error) {
      await this.stop(target, threadId).catch(() => undefined)
      throw error
    }
  }

  list(threadId: string): string[] {
    return [...this.sessions.values()]
      .filter((session) => session.threadId === threadId)
      .map((session) => PREFIX + session.id)
  }

  async stop(target: string, threadId: string): Promise<void> {
    const session = this.owned(target, threadId)
    // Revoke before any asynchronous cleanup. A failed termination never preserves authority.
    this.sessions.delete(session.id)
    clearTimeout(session.timer)
    clearInterval(session.monitor)
    session.closeControl()
    await this.backend.stop(session.id).catch(() => undefined)
  }

  async revokeAll(): Promise<void> {
    this.generation++
    this.launchGrants.clear()
    await Promise.all(
      [...this.sessions.values()].map((session) =>
        this.stop(PREFIX + session.id, session.threadId),
      ),
    )
  }
}

export const childCopseSessions = new ChildCopseSessions({
  start: (id, bundle, entry, profile): Promise<DesktopApp> =>
    getDesktopControlService().startChild(id, bundle, entry, profile),
  validate: (id): Promise<DesktopApp> => {
    const service = peekDesktopControlService()
    if (!service) throw new Error('Desktop control stopped.')
    return service.validateChild(id)
  },
  stop: async (id): Promise<void> => {
    await peekDesktopControlService()?.stopChild(id)
  },
})

export function childCopseOwner(): { threadId: string; root: string } {
  const context = getThreadExecutionContext()
  if (!context || isActiveSshWorkspace())
    throw new Error('Child Copse requires a local workspace thread.')
  return { threadId: context.threadId, root: context.root }
}

export async function launchChildCopse(
  signal?: AbortSignal,
): Promise<{ target: string; workspace: string }> {
  signal?.throwIfAborted()
  const showChildCopseControl = controlWindow
  if (!showChildCopseControl) throw new Error('Child Copse requires the desktop app.')
  const { threadId, root } = childCopseOwner()
  const entry = await realpath(join(root, 'dist/main/index.js'))
  const bundle = await realpath(join(root, 'node_modules/electron/dist/Copse.app'))
  const scratch = join(root, '.tmp')
  await mkdir(scratch, { recursive: true })
  const profile = await mkdtemp(join(scratch, 'child-copse-'))
  const workspace = join(profile, 'test-project')
  await mkdir(workspace)
  const target = await childCopseSessions.start(
    threadId,
    bundle,
    entry,
    profile,
    showChildCopseControl,
  )
  if (signal?.aborted) {
    await childCopseSessions.stop(target, threadId)
    signal.throwIfAborted()
  }
  return { target, workspace }
}
