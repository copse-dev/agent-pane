import { delimiter, resolve } from 'node:path'

export const HARBOR_VERSION = '0.16.1'
export const TERMINAL_BENCH_DATASET = 'terminal-bench@2.0'
export const TERMINAL_BENCH_AGENT = 'benchmarks.terminal_bench.copse_agent:CopseTerminalAgent'
export const DEFAULT_TERMINAL_BENCH_MIN_FREE_DISK_GIB = 15
export const DEFAULT_TERMINAL_BENCH_PREFETCH_MIN_FREE_DISK_GIB = 30

export interface TerminalBenchLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

function exceptionType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('exception_type' in value)) return undefined
  return typeof value.exception_type === 'string' ? value.exception_type : undefined
}

export function terminalBenchCompletedTaskNames(records: readonly unknown[]): string[] {
  const completed = new Set<string>()
  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue
    const taskName = 'task_name' in record ? record.task_name : undefined
    const exceptionInfo = 'exception_info' in record ? record.exception_info : undefined
    if (typeof taskName !== 'string' || !taskName) continue
    // An agent timeout is a valid benchmark outcome. Other exceptions are
    // infrastructure-invalid and remain eligible when a suite is resumed.
    if (exceptionInfo === null || exceptionType(exceptionInfo) === 'AgentTimeoutError') {
      completed.add(taskName)
    }
  }
  return [...completed].sort()
}

function terminalBenchFreeDiskBytes(
  envName: string,
  fallbackGib: number,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[envName]?.trim()
  const gib = raw ? Number(raw) : fallbackGib
  if (!Number.isFinite(gib) || gib < 0) {
    throw new Error(`${envName} must be a non-negative number, received '${raw ?? ''}'.`)
  }
  return gib * 1024 ** 3
}

export function terminalBenchMinimumFreeDiskBytes(env: NodeJS.ProcessEnv = process.env): number {
  return terminalBenchFreeDiskBytes(
    'COPSE_TERMINAL_MIN_FREE_DISK_GIB',
    DEFAULT_TERMINAL_BENCH_MIN_FREE_DISK_GIB,
    env,
  )
}

export function terminalBenchPrefetchMinimumFreeDiskBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return terminalBenchFreeDiskBytes(
    'COPSE_TERMINAL_PREFETCH_MIN_FREE_DISK_GIB',
    DEFAULT_TERMINAL_BENCH_PREFETCH_MIN_FREE_DISK_GIB,
    env,
  )
}

export function terminalBenchDiskSpaceError(
  availableBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const requiredBytes = terminalBenchMinimumFreeDiskBytes(env)
  if (availableBytes >= requiredBytes) return undefined
  const availableGiB = (availableBytes / 1024 ** 3).toFixed(1)
  const requiredGiB = (requiredBytes / 1024 ** 3).toFixed(1)
  return `only ${availableGiB} GiB is free; at least ${requiredGiB} GiB is required before starting Docker tasks`
}

export function terminalBenchFatalInfrastructureOutput(text: string): string | undefined {
  const checks: ReadonlyArray<[RegExp, string]> = [
    [/Docker daemon is not running/i, 'Docker daemon stopped'],
    [/Docker Desktop is unable to start/i, 'Docker Desktop could not start'],
    [
      /failed to register layer:[^\n]*(?:no space left on device|input\/output error)/i,
      'Docker image extraction failed',
    ],
    [
      /com\.docker\.docker[^\n]*no space left on device/i,
      'Docker Desktop ran out of host disk space',
    ],
  ]
  return checks.find(([pattern]) => pattern.test(text))?.[1]
}

function hasFlag(args: readonly string[], long: string, short?: string): boolean {
  return args.some(
    (arg) =>
      arg === long ||
      arg.startsWith(`${long}=`) ||
      (short !== undefined && (arg === short || arg.startsWith(`${short}=`))),
  )
}

export function terminalBenchModel(env: NodeJS.ProcessEnv): string {
  const model = env['LM_STUDIO_MODEL']?.trim()
  if (!model) {
    throw new Error('Set LM_STUDIO_MODEL to the model loaded by LM Studio.')
  }
  return model
}

export function buildTerminalBenchLaunch(
  rawArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): TerminalBenchLaunch {
  const fullSuite = rawArgs.includes('--all')
  const args = rawArgs.filter((arg) => arg !== '--all' && arg !== '--dry-run')
  const model = terminalBenchModel(env)
  const repositoryRoot = resolve()
  const jobsDir = resolve('bench-results/terminal-bench')
  const pythonPath = env['PYTHONPATH']

  const harborArgs = [
    '--from',
    `harbor==${HARBOR_VERSION}`,
    'harbor',
    'run',
    '--dataset',
    TERMINAL_BENCH_DATASET,
    '--agent',
    TERMINAL_BENCH_AGENT,
    '--model',
    model,
    '--jobs-dir',
    jobsDir,
  ]

  if (!hasFlag(args, '--n-concurrent', '-n')) harborArgs.push('--n-concurrent', '1')
  if (!hasFlag(args, '--n-attempts', '-k')) harborArgs.push('--n-attempts', '1')
  if (!fullSuite && !hasFlag(args, '--n-tasks', '-l') && !hasFlag(args, '--task', '-t')) {
    harborArgs.push('--n-tasks', '1')
  }
  harborArgs.push(...args)

  return {
    command: 'uvx',
    args: harborArgs,
    env: {
      ...env,
      COPSE_TERMINAL_AGENT_BUNDLE: resolve('dist-test/terminal-bench-agent.cjs'),
      PYTHONPATH: pythonPath ? `${repositoryRoot}${delimiter}${pythonPath}` : repositoryRoot,
    },
  }
}

export function shellDisplay(command: string, args: readonly string[]): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  return [command, ...args].map(quote).join(' ')
}
