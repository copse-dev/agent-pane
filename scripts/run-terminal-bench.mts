import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statfsSync } from 'node:fs'
import { glob, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  buildTerminalBenchLaunch,
  shellDisplay,
  terminalBenchCompletedTaskNames,
  terminalBenchDiskSpaceError,
  terminalBenchFatalInfrastructureOutput,
} from './lib/terminal-bench.mts'
import { buildTerminalBenchAgentBundle } from './build-terminal-bench-agent.mts'

async function resumeArgs(rawArgs: readonly string[]): Promise<string[]> {
  if (!rawArgs.includes('--resume')) return [...rawArgs]
  if (!rawArgs.includes('--all')) throw new Error('--resume requires --all')
  const records: unknown[] = []
  for await (const path of glob('bench-results/terminal-bench/*/*/result.json')) {
    try {
      records.push(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      console.warn(`bench:terminal: ignoring unreadable result ${path}: ${String(error)}`)
    }
  }
  const completed = terminalBenchCompletedTaskNames(records)
  console.log(`bench:terminal resume=${String(completed.length)} completed tasks excluded`)
  return [
    ...rawArgs.filter((arg) => arg !== '--resume'),
    ...completed.flatMap((taskName) => ['--exclude-task-name', taskName]),
  ]
}

let launch
try {
  launch = buildTerminalBenchLaunch(await resumeArgs(process.argv.slice(2)))
} catch (error) {
  console.error(`bench:terminal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

console.log(`bench:terminal command=${shellDisplay(launch.command, launch.args)}`)
if (process.argv.includes('--dry-run')) process.exit(0)

const stats = statfsSync(resolve())
const diskError = terminalBenchDiskSpaceError(stats.bavail * stats.bsize, launch.env)
if (diskError) {
  console.error(`bench:terminal: ${diskError}. Free space and try again.`)
  process.exit(1)
}

const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
  encoding: 'utf8',
})
if (docker.error || docker.status !== 0) {
  const detail = docker.error?.message || docker.stderr.trim() || docker.stdout.trim()
  console.error(`bench:terminal: Docker is unavailable: ${detail}`)
  process.exit(1)
}

const prebuiltBundle = launch.env['COPSE_TERMINAL_PREBUILT_AGENT_BUNDLE']?.trim()
if (prebuiltBundle) {
  if (!existsSync(prebuiltBundle)) {
    console.error(`bench:terminal: prebuilt agent bundle does not exist: ${prebuiltBundle}`)
    process.exit(1)
  }
  console.log(`bench:terminal bundle=${prebuiltBundle} (prebuilt)`)
} else {
  console.log(`bench:terminal bundle=${await buildTerminalBenchAgentBundle()}`)
}

const child = spawn(launch.command, launch.args, {
  cwd: process.cwd(),
  env: launch.env,
  stdio: ['inherit', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
})

let fatalInfrastructure: string | undefined
let scanTail = ''
const stopChild = (): void => {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

const forwardAndScan = (chunk: Buffer, destination: NodeJS.WriteStream): void => {
  destination.write(chunk)
  if (fatalInfrastructure) return
  const text = `${scanTail}${chunk.toString('utf8')}`
  scanTail = text.slice(-2_048)
  fatalInfrastructure = terminalBenchFatalInfrastructureOutput(text)
  if (fatalInfrastructure) {
    console.error(
      `\nbench:terminal: ${fatalInfrastructure}; stopping the suite before later tasks are skipped.`,
    )
    stopChild()
  }
}

child.stdout.on('data', (chunk: Buffer) => {
  forwardAndScan(chunk, process.stdout)
})
child.stderr.on('data', (chunk: Buffer) => {
  forwardAndScan(chunk, process.stderr)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopChild()
  })
}

const status = await new Promise<number>((resolveStatus) => {
  child.once('error', (error) => {
    console.error(`bench:terminal: unable to start ${launch.command}: ${error.message}`)
    resolveStatus(1)
  })
  child.once('close', (code) => {
    resolveStatus(fatalInfrastructure ? 1 : (code ?? 1))
  })
})
process.exit(status)
