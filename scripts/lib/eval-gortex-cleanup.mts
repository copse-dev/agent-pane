import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { setTimeout } from 'node:timers/promises'

interface ProcessIdentity {
  pid: number
  started: string
  executable: string
  home: string
  daemon: boolean
  privateFiles: boolean
}

interface ProcessBoundary {
  candidates: () => number[]
  inspect: (pid: number, home: string) => ProcessIdentity | null
  terminate: (pid: number) => void
  pause: () => Promise<void>
}

interface ProcessInspection {
  alive: (pid: number) => void
  status: (pid: number) => { started: string; state: string }
  home: (pid: number) => string | undefined
  details: (pid: number) => { executable: string; files: string[] }
  canonical: (path: string) => string
  pidfile: (home: string) => number | null
  uid: (pid: number) => number | undefined
  ownUid: number | undefined
}

function command(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
}

function missingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}

function readPidfile(home: string): number | null {
  try {
    const raw = readFileSync(join(home, '.gortex/cache/daemon.pid'), 'utf8').trim()
    return /^[1-9]\d*$/.test(raw) ? Number(raw) : null
  } catch {
    return null
  }
}

/** Keep mutable scheduler flags out of the stable identity used before signalling. */
export function parsePsIdentity(output: string): { started: string; state: string } {
  const match = /^(.*\S)\s+(\S+)$/.exec(output.trim())
  if (!match?.[1] || !match[2]) throw new Error('Incomplete process start/status')
  return { started: match[1].trim(), state: match[2] }
}

const processInspection: ProcessInspection = {
  alive: (pid) => {
    process.kill(pid, 0)
  },
  status: (pid) => parsePsIdentity(command('ps', ['-p', String(pid), '-o', 'lstart=,stat='])),
  // Capture environments only transiently. Never include them in diagnostics.
  home: (pid) => {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${String(pid)}/environ`, 'utf8')
        .split('\0')
        .find((entry) => entry.startsWith('HOME='))
        ?.slice(5)
    }
    const environment = command('ps', ['eww', '-p', String(pid), '-o', 'command='])
    return /(?:^|\s)HOME=(.*?)(?=\s[A-Za-z_][A-Za-z_0-9]*=|$)/.exec(environment)?.[1]?.trim()
  },
  details: (pid) => {
    if (process.platform === 'linux') {
      const executable = readlinkSync(`/proc/${String(pid)}/exe`)
      const files = readdirSync(`/proc/${String(pid)}/fd`).flatMap((fd) => {
        try {
          return [readlinkSync(`/proc/${String(pid)}/fd/${fd}`)]
        } catch {
          return []
        }
      })
      return { executable, files }
    }
    const fields = command('lsof', ['-a', '-p', String(pid), '-Ffn']).split('\n')
    let descriptor = ''
    let executable = ''
    const files: string[] = []
    for (const field of fields) {
      if (field.startsWith('f')) descriptor = field.slice(1)
      if (!field.startsWith('n')) continue
      const path = field.slice(1)
      if (descriptor === 'txt' && basename(path) === 'gortex') executable = path
      files.push(path)
    }
    return { executable, files }
  },
  canonical: realpathSync,
  pidfile: readPidfile,
  uid: (pid) => {
    const uid = command('ps', ['-p', String(pid), '-o', 'uid=']).trim()
    return /^\d+$/.test(uid) ? Number(uid) : undefined
  },
  ownUid: process.getuid?.(),
}

function inaccessibleForeignProcess(
  pid: number,
  error: unknown,
  boundary: ProcessInspection,
): boolean {
  if (!(error instanceof Error && 'code' in error && error.code === 'EPERM')) return false
  try {
    const uid = boundary.uid(pid)
    return boundary.ownUid !== undefined && uid !== undefined && uid !== boundary.ownUid
  } catch {
    return false
  }
}

/** Classify the profile before requiring executable or open-file inspection. */
export function inspectEvalGortexProcess(
  pid: number,
  targetHome: string,
  boundary: ProcessInspection = processInspection,
): ProcessIdentity | null {
  try {
    const { started, state } = boundary.status(pid)
    if (state.startsWith('Z')) return null
    const home = boundary.home(pid)
    if (!home) throw new Error('Missing process HOME')
    let resolvedHome: string
    if (home !== targetHome) {
      try {
        resolvedHome = boundary.canonical(home)
      } catch {
        // A missing foreign HOME cannot identify this still-present profile.
        return null
      }
      if (resolvedHome !== targetHome) return null
    } else {
      resolvedHome = boundary.canonical(home)
      if (resolvedHome !== targetHome) return null
    }
    boundary.alive(pid)
    const { executable, files } = boundary.details(pid)
    if (!executable) throw new Error('Incomplete process identity')
    return {
      pid,
      started,
      executable: boundary.canonical(executable),
      home: resolvedHome,
      daemon: boundary.pidfile(resolvedHome) === pid,
      privateFiles: files.some((file) => file.startsWith(`${resolvedHome}${sep}`)),
    }
  } catch {
    try {
      boundary.alive(pid)
    } catch (probeError) {
      if (missingProcess(probeError) || inaccessibleForeignProcess(pid, probeError, boundary))
        return null
    }
    // Unknown or matching-profile identity failures still preserve the profile.
    throw new Error(`Cannot verify Gortex cleanup candidate PID ${String(pid)}`)
  }
}

const processBoundary: ProcessBoundary = {
  candidates: () =>
    command('ps', ['-axo', 'pid=,comm='])
      .split('\n')
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
        return match?.[1] && match[2] && basename(match[2]) === 'gortex' ? [Number(match[1])] : []
      }),
  inspect: inspectEvalGortexProcess,
  terminate: (pid) => {
    process.kill(pid, 'SIGTERM')
  },
  pause: () => setTimeout(100),
}

/** Reap only services belonging to this disposable eval profile, before deleting its files. */
export async function cleanupEvalGortex(
  userData: string,
  boundary: ProcessBoundary = processBoundary,
): Promise<void> {
  if (!/^\.wdio-eval-userdata-[a-f0-9]{8}-.+$/.test(basename(userData))) {
    throw new Error('Gortex eval cleanup requires a generated eval userData directory')
  }
  const profile = realpathSync(userData)
  if (profile !== join(realpathSync(dirname(userData)), basename(userData))) {
    throw new Error('Refusing aliased eval profile')
  }
  const home = join(profile, 'gortex')
  const owned = (): ProcessIdentity[] => {
    const pidfile = readPidfile(home)
    const pids = new Set([...boundary.candidates(), ...(pidfile === null ? [] : [pidfile])])
    return [...pids].flatMap((pid) => {
      const identity = boundary.inspect(pid, home)
      if (!identity || identity.home !== home) return []
      if (
        basename(identity.executable) !== 'gortex' ||
        (!identity.daemon && !identity.privateFiles)
      ) {
        throw new Error(
          `Cannot establish ownership of eval Gortex PID ${String(pid)}; preserving profile`,
        )
      }
      return [identity]
    })
  }
  const signalled = new Map<number, ProcessIdentity>()
  for (let attempt = 0; attempt < 50; attempt++) {
    const services = owned()
    if (services.length === 0) return
    // Order SIGTERM requests, without claiming clients have already exited.
    for (const original of services.sort((a, b) => Number(a.daemon) - Number(b.daemon))) {
      const previous = signalled.get(original.pid)
      if (previous?.started === original.started && previous.executable === original.executable)
        continue
      const current = boundary.inspect(original.pid, home)
      if (!current) continue
      if (
        current.started !== original.started ||
        current.executable !== original.executable ||
        current.home !== home
      ) {
        throw new Error(
          `Eval Gortex PID ${String(original.pid)} changed identity; preserving profile`,
        )
      }
      try {
        // POSIX numeric-PID signals cannot atomically pin identity across this final gap.
        boundary.terminate(original.pid)
        signalled.set(original.pid, original)
      } catch (error) {
        if (!missingProcess(error)) throw error
      }
    }
    await boundary.pause()
  }
  if (owned().length === 0) return
  throw new Error('Eval Gortex did not stop after SIGTERM; preserving profile')
}
