import { getWorkspaceRoot } from './workspace.ts'
import { afterSandboxedCommand, spawnInProjectSandbox } from '../project-sandbox/index.ts'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string
    signal?: AbortSignal
    unsandboxed?: boolean
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<CommandResult> {
  const cwd = opts.cwd ?? getWorkspaceRoot() ?? process.cwd()

  return new Promise((resolve, reject) => {
    void (async () => {
      try {
        const spawnOpts: Parameters<typeof spawnInProjectSandbox>[2] = {
          cwd,
          stdio: 'pipe',
        }
        if (opts.unsandboxed !== undefined) spawnOpts.unsandboxed = opts.unsandboxed
        if (opts.signal) spawnOpts.signal = opts.signal
        if (opts.env) spawnOpts.env = opts.env
        const proc = await spawnInProjectSandbox(cmd, args, spawnOpts)
        let stdout = '',
          stderr = ''
        proc.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString()
        })
        proc.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        proc.on('close', (code) => {
          afterSandboxedCommand()
          resolve({ stdout, stderr, code: code ?? 0 })
        })
        proc.on('error', (err) => {
          afterSandboxedCommand()
          reject(err instanceof Error ? err : new Error(String(err)))
        })
        opts.signal?.addEventListener('abort', () => proc.kill())
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })()
  })
}
