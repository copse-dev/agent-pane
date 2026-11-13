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
  inspect: (pid: number) => ProcessIdentity | null
  terminate: (pid: number) => void
  pause: () => Promise<void>
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

function inspectProcess(pid: number): ProcessIdentity | null {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (missingProcess(error)) return null
    throw error
  }
  // Capture environments only transiently. Never include them in diagnostics.
  try {
    const started = command('ps', ['-p', String(pid), '-o', 'lstart=,stat=']).trim()
    if (!started || /\sZ\S*$/.test(started)) return null
    let home: string | undefined
    let executable: string
    let files: string[]
    if (process.platform === 'linux') {
      home = readFileSync(`/proc/${String(pid)}/environ`, 'utf8')
        .split('\0')
        .find((entry) => entry.startsWith('HOME='))
        ?.slice(5)
      executable = readlinkSync(`/proc/${String(pid)}/exe`)
      files = readdirSync(`/proc/${String(pid)}/fd`).flatMap((fd) => {
        try {
          return [readlinkSync(`/proc/${String(pid)}/fd/${fd}`)]
        } catch {
          return []
        }
      })
    } else {
      const environment = command('ps', ['eww', '-p', String(pid), '-o', 'command='])
      home = /(?:^|\s)HOME=(.*?)(?=\s[A-Za-z_][A-Za-z_0-9]*=|$)/.exec(environment)?.[1]?.trim()
      const fields = command('lsof', ['-a', '-p', String(pid), '-Ffn']).split('\n')
      let descriptor = ''
      executable = ''
      files = []
      for (const field of fields) {
        if (field.startsWith('f')) descriptor = field.slice(1)
        if (!field.startsWith('n')) continue
        const path = field.slice(1)
        if (descriptor === 'txt' && basename(path) === 'gortex') executable = path
        files.push(path)
      }
    }
    if (!home || !executable) throw new Error('Incomplete process identity')
    const resolvedHome = realpathSync(home)
    return {
      pid,
      started,
      executable: realpathSync(executable),
      home: resolvedHome,
      daemon: readPidfile(resolvedHome) === pid,
      privateFiles: files.some((file) => file.startsWith(`${resolvedHome}${sep}`)),
    }
  } catch {
    try {
      process.kill(pid, 0)
    } catch (probeError) {
      if (missingProcess(probeError)) return null
    }
    // A live candidate we cannot inspect must not be silently declared absent.
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
  inspect: inspectProcess,
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
      const identity = boundary.inspect(pid)
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
  // Existing clients can autostart a daemon: terminate them before the daemon.
  for (const original of owned().sort((a, b) => Number(a.daemon) - Number(b.daemon))) {
    const current = boundary.inspect(original.pid)
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
      boundary.terminate(original.pid)
    } catch (error) {
      if (!missingProcess(error)) throw error
    }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (owned().length === 0) return
    await boundary.pause()
  }
  throw new Error('Eval Gortex did not stop after SIGTERM; preserving profile')
}
