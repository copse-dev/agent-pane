/**
 * A TCP port a process holds in LISTEN state, discovered by scanning the host
 * (not by tracking what Copse spawned). `pid`/`command` are best-effort: some
 * tools (Windows `netstat`) name the pid but not the command, and a port whose
 * owner we can't read leaves `pid` null.
 */
export interface ListeningPort {
  /** TCP port number bound in LISTEN state. */
  port: number
  /** Owning process id, or null when the tool couldn't attribute one. */
  pid: number | null
  /** Best-effort process/command name ('' when the tool doesn't report it). */
  command: string
  /** Bind address as reported, normalised without brackets (e.g. '0.0.0.0', '127.0.0.1', '::', '::1', '*'). */
  address: string
}

/** True for a real, in-range TCP port. Filters `*`, named ports, and garbage. */
function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * Split a `host:port` token into its address and port, taking the LAST colon so
 * IPv6 literals (`[::1]:3000`, `[::]:22`) parse correctly, and stripping the
 * IPv6 brackets. Returns null when there's no numeric port.
 */
export function splitAddrPort(token: string): { address: string; port: number } | null {
  const idx = token.lastIndexOf(':')
  if (idx < 0) return null
  const port = Number(token.slice(idx + 1))
  if (!isPort(port)) return null
  const address = token.slice(0, idx).replace(/^\[/, '').replace(/\]$/, '')
  return { address, port }
}

/**
 * Parse Linux `ss -tlnpH` output (no header, numeric, listening TCP, processes).
 * Columns: State Recv-Q Send-Q Local Peer Process, e.g.
 *   LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=12345,fd=23))
 * A socket with no process info (missing sudo) still yields a port with pid null.
 */
export function parseSs(output: string): ListeningPort[] {
  const ports: ListeningPort[] = []
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== 'LISTEN' || cols.length < 4) continue
    const local = cols[3]
    if (!local) continue
    const parsed = splitAddrPort(local)
    if (!parsed) continue
    const rest = cols.slice(5).join(' ')
    const pidMatch = /pid=(\d+)/.exec(rest)
    const nameMatch = /"([^"]+)",pid=/.exec(rest)
    ports.push({
      port: parsed.port,
      pid: pidMatch ? Number(pidMatch[1]) : null,
      command: nameMatch?.[1] ?? '',
      address: parsed.address,
    })
  }
  return ports
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` machine output (field mode), which is
 * stable across lsof versions unlike its columns. Records group under a `p<pid>`
 * line, carry a `c<command>`, and emit one `n<addr:port>` per listening endpoint:
 *   p12345 \n cnode \n n*:3000 \n n[::1]:3000 \n p999 \n credis-server \n n127.0.0.1:6379
 */
export function parseLsof(output: string): ListeningPort[] {
  const ports: ListeningPort[] = []
  let pid: number | null = null
  let command = ''
  for (const line of output.split('\n')) {
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      pid = Number(value)
      command = ''
    } else if (tag === 'c') {
      command = value
    } else if (tag === 'n') {
      const parsed = splitAddrPort(value)
      if (parsed) {
        ports.push({ port: parsed.port, pid, command, address: parsed.address })
      }
    }
  }
  return ports
}

/**
 * Parse Windows `netstat -ano` output. `netstat` names the pid but not the
 * command (enrich later via `tasklist` if needed), so `command` stays ''.
 *   TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345
 */
export function parseNetstat(output: string): ListeningPort[] {
  const ports: ListeningPort[] = []
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== 'TCP' || !cols.includes('LISTENING')) continue
    const local = cols[1]
    const pidStr = cols[cols.length - 1]
    if (!local) continue
    const parsed = splitAddrPort(local)
    if (!parsed) continue
    const pid = Number(pidStr)
    ports.push({
      port: parsed.port,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      command: '',
      address: parsed.address,
    })
  }
  return ports
}

export interface ScanPlan {
  file: string
  args: string[]
  parse: (out: string) => ListeningPort[]
}

const LSOF_PLAN: ScanPlan = {
  file: 'lsof',
  args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'],
  parse: parseLsof,
}
const SS_PLAN: ScanPlan = { file: 'ss', args: ['-tlnpH'], parse: parseSs }
const NETSTAT_PLAN: ScanPlan = { file: 'netstat', args: ['-ano'], parse: parseNetstat }

/**
 * Ordered scan tools to try for the given platform, falling through when one is
 * absent (e.g. minimal Linux containers ship `lsof` but not `ss`, and vice
 * versa). Pure; the runner in host-scan.ts walks this list. First tool that
 * runs wins — even a genuinely empty result stops the search.
 */
export function scanCandidates(platform: NodeJS.Platform = process.platform): ScanPlan[] {
  if (platform === 'win32') return [NETSTAT_PLAN]
  if (platform === 'linux') return [SS_PLAN, LSOF_PLAN, NETSTAT_PLAN]
  // macOS (and other BSDs).
  return [LSOF_PLAN, NETSTAT_PLAN]
}

/**
 * De-dupe by (port, pid): a server bound on both IPv4 and IPv6 shows up twice
 * (e.g. `*:3000` and `[::1]:3000`) and the panel wants one row per listener.
 * Keeps the first, preferring a loopback/any address for display.
 */
export function dedupePorts(ports: ListeningPort[]): ListeningPort[] {
  const byKey = new Map<string, ListeningPort>()
  for (const p of ports) {
    const key = `${String(p.port)}:${String(p.pid ?? '')}`
    if (!byKey.has(key)) byKey.set(key, p)
  }
  return [...byKey.values()]
}
