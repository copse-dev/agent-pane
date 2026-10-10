import { basename } from 'node:path'

interface AcpSessionProcess {
  threadId: string
  projectId?: string
  command: string
  processId: () => number | undefined
}

// Keep this registry independent of the session pool: process sampling must not
// load the agent/bridge runtime, and registration lasts through shutdown.
const sessions = new Set<AcpSessionProcess>()

export function registerAcpSessionProcess(session: AcpSessionProcess): () => void {
  sessions.add(session)
  return () => {
    sessions.delete(session)
  }
}

export function listAcpSessionProcesses(): {
  pid: number
  label: string
  threadId: string
  projectId?: string
}[] {
  return [...sessions].flatMap((session) => {
    const pid = session.processId()
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return []
    return [
      {
        pid,
        label: basename(session.command),
        threadId: session.threadId,
        ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
      },
    ]
  })
}
