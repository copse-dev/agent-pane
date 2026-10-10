import type { NetworkActivityRow, NetworkActivitySnapshot } from '@shared/types/network-activity.ts'

interface NetworkActivityHandle {
  active: () => void
  transfer: (sent: number, received: number) => void
  finish: (
    status: Exclude<NetworkActivityRow['status'], 'running' | 'connecting' | 'active'>,
    exitCode?: number | null,
  ) => void
}

const MAX_ACTIVITY_ROWS = 300

/** Bounded session history shared by app windows. Old completed rows are evicted first. */
export class NetworkActivityLog {
  private readonly rows = new Map<number, NetworkActivityRow>()
  private nextId = 0
  private dropped = 0

  start(
    input: Pick<NetworkActivityRow, 'source' | 'label'> &
      Partial<Pick<NetworkActivityRow, 'target' | 'threadId' | 'projectId'>>,
  ): NetworkActivityHandle {
    const row: NetworkActivityRow = {
      id: ++this.nextId,
      source: input.source,
      label: input.label,
      target: input.target ?? null,
      threadId: input.threadId ?? null,
      projectId: input.projectId ?? null,
      startedAt: Date.now(),
      endedAt: null,
      status: input.source === 'command' ? 'running' : 'connecting',
      exitCode: null,
      bytesSent: input.source === 'container' ? 0 : null,
      bytesReceived: input.source === 'container' ? 0 : null,
    }
    if (this.rows.size >= MAX_ACTIVITY_ROWS) {
      const oldest =
        [...this.rows.values()].find((entry) => entry.endedAt !== null) ??
        this.rows.values().next().value
      if (oldest) this.rows.delete(oldest.id)
      this.dropped++
    }
    this.rows.set(row.id, row)
    return {
      active: (): void => {
        if (row.endedAt === null) row.status = 'active'
      },
      transfer: (sent: number, received: number): void => {
        if (row.endedAt !== null) return
        row.bytesSent = sent
        row.bytesReceived = received
      },
      finish: (
        status: Exclude<NetworkActivityRow['status'], 'running' | 'connecting' | 'active'>,
        exitCode: number | null = null,
      ): void => {
        if (row.endedAt !== null) return
        row.status = status
        row.exitCode = exitCode
        row.endedAt = Date.now()
      },
    }
  }

  snapshot(): NetworkActivitySnapshot {
    return {
      rows: [...this.rows.values()].reverse().map((row) => ({ ...row })),
      dropped: this.dropped,
    }
  }
}

export const networkActivity = new NetworkActivityLog()

/** Only fixed, known verbs are retained; arbitrary arguments can contain secrets. */
export function networkCommandLabel(command: string, args: readonly string[]): string | null {
  if (command === 'gh') {
    const verbs = new Set([
      'api',
      'pr',
      'issue',
      'repo',
      'run',
      'workflow',
      'release',
      'auth',
      'search',
      'gist',
    ])
    const actions = new Set([
      'list',
      'view',
      'status',
      'checks',
      'create',
      'edit',
      'merge',
      'close',
      'download',
      'clone',
      'fetch',
    ])
    const verb = args[0]
    const action = args[1]
    return [
      'gh',
      verb && verbs.has(verb) ? verb : null,
      verb !== 'api' && action && actions.has(action) ? action : null,
    ]
      .filter(Boolean)
      .join(' ')
  }
  if (command === 'git' && ['fetch', 'push', 'pull', 'clone', 'ls-remote'].includes(args[0] ?? ''))
    return `git ${args[0] ?? ''}`
  if (command === 'curl' || command === 'wget') return command
  return null
}
