/** Serialisable view of an agent-started background task (issue #691). */
export interface BackgroundProcessInfo {
  id: string
  command: string
  cwd: string
  startedAt: number
  /** Detected loopback URL (e.g. http://localhost:3000), or null. */
  url: string | null
  running: boolean
  exitCode: number | null
}
