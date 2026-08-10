import { runCommand } from '../exec/command-runner.ts'
import { dedupePorts, scanCandidates, type ListeningPort } from './port-scan.ts'
import { parsePsPairs } from './process-ancestry.ts'

/**
 * The impure edge of port discovery: run the platform scan tool + read the
 * process table. Kept apart from the pure parsers (port-scan / process-ancestry)
 * so those stay unit-testable without pulling in the subprocess/native graph.
 */

/** The outcome of one scan. `tool` is null when the host has no scanner at all. */
export interface PortScan {
  /** The scan tool that ran (`ss`, `lsof`, `netstat`), or null when none exists. */
  tool: string | null
  ports: ListeningPort[]
}

/**
 * Scan the host for listening TCP ports, trying each platform candidate tool in
 * order and using the first that runs (a missing binary rejects with ENOENT, so
 * we fall through).
 *
 * The tool name is reported alongside the ports because the two empty results
 * mean opposite things: no rows from a tool that ran is "nothing is listening",
 * while no tool at all is "we cannot see". Collapsing both to `[]` makes the
 * panel claim the first when it means the second.
 */
export async function scanListeningPorts(port?: number): Promise<PortScan> {
  for (const plan of scanCandidates(process.platform, port)) {
    try {
      const { stdout, code } = await runCommand(plan.file, plan.args, { unsandboxed: true })
      // netstat/ss exit non-zero on some flag combos even while printing usable
      // rows; trust the parse when we got output, otherwise move on.
      const parsed = plan
        .parse(stdout)
        .filter((candidate) => port === undefined || candidate.port === port)
      if (code === 0 || parsed.length > 0) return { tool: plan.file, ports: dedupePorts(parsed) }
    } catch {
      // Tool absent — try the next candidate.
    }
  }
  return { tool: null, ports: [] }
}

/**
 * Read the whole process table as a pid→ppid map in one shot, so attribution is a
 * cheap in-memory climb rather than a syscall per hop. `ps` covers macOS/Linux;
 * Windows uses PowerShell's CIM view. Returns an empty map on failure (ports then
 * attribute to null and simply render inert — safe, never a false "ours").
 */
export async function readParentMap(): Promise<Map<number, number>> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await runCommand(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ],
        { unsandboxed: true },
      )
      return parsePsPairs(stdout)
    }
    const { stdout } = await runCommand('ps', ['-Ao', 'pid=,ppid='], { unsandboxed: true })
    return parsePsPairs(stdout)
  } catch {
    return new Map()
  }
}
