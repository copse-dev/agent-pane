import { spawn } from 'node:child_process'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, stdio: 'pipe' })
    let stdout = '',
      stderr = ''
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }))
    proc.on('error', reject)
    opts.signal?.addEventListener('abort', () => proc.kill())
  })
}
