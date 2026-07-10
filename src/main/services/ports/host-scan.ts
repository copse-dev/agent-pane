import { runCommand } from '../exec/command-runner.ts'
import { dedupePorts, scanCandidates, type ListeningPort } from './port-scan.ts'
import { parsePsPairs } from './process-ancestry.ts'

/**
 * The impure edge of port discovery: run the platform scan tool + read the
 * process table. Kept apart from the pure parsers (port-scan / process-ancestry)
 * so those stay unit-testable without pulling in the subprocess/native graph.
 */

/**
 * Scan the host for listening TCP ports, trying each platform candidate tool in
 * order and using the first that runs (a missing binary rejects with ENOENT, so
 * we fall through). Returns [] when none are available.
 */
export async function scanListeningPorts(): Promise<ListeningPort[]> {
  for (const plan of scanCandidates()) {
    try {
      const { stdout, code } = await runCommand(plan.file, plan.args, { unsandboxed: true })
      // netstat/ss exit non-zero on some flag combos even while printing usable
      // rows; trust the parse when we got output, otherwise move on.
      const parsed = plan.parse(stdout)
      if (code === 0 || parsed.length > 0) return dedupePorts(parsed)
    } catch {
      // Tool absent — try the next candidate.
    }
  }
  return []
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
