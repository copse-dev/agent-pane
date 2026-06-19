import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getWorkspaceRoot } from '../services/workspace.ts'
import { getMainWindow } from '../windows/create-main-window.ts'
import { afterSandboxedCommand, spawnShellInProjectSandbox } from '../project-sandbox/index.ts'

export const runShellTool: ToolDefinition = {
  name: 'run_shell',
  description:
    'Run a shell command in the workspace directory. Output is streamed to the conversation. Commands contained within the sandbox auto-run; network or outside-workspace access prompts for approval.',
  parameters: z.object({
    command: z.string().describe('Shell command to run'),
    timeout_ms: z.number().int().min(1000).max(300_000).optional().default(30_000),
  }),
  async execute({ command, timeout_ms }, signal) {
    const cwd = getWorkspaceRoot()
    if (!cwd) return 'No workspace open.'

    const win = getMainWindow()

    return new Promise<string>((resolve, reject) => {
      void (async () => {
        // Use Node's built-in child_process rather than a native pty module:
        // node-pty must be ABI-matched to Electron and otherwise fails at spawn
        // time with posix_spawnp errors. We lose TTY behaviour but gain
        // reliability, and still stream output to the conversation.
        let proc
        try {
          proc = await spawnShellInProjectSandbox(command, {
            cwd,
            env: process.env,
            stdio: 'pipe',
            signal,
          })
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }

        let output = ''
        let settled = false
        const stream = (data: Buffer) => {
          const text = data.toString()
          output += text
          win?.webContents.send('agent:shell_output', text)
        }
        proc.stdout?.on('data', stream)
        proc.stderr?.on('data', stream)

        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          if (!settled) {
            settled = true
            reject(new Error(`Command timed out after ${timeout_ms}ms`))
          }
        }, timeout_ms)

        const finish = () => {
          afterSandboxedCommand()
        }

        proc.on('error', (err) => {
          clearTimeout(timer)
          finish()
          if (!settled) {
            settled = true
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })

        proc.on('close', (code) => {
          clearTimeout(timer)
          finish()
          if (settled) return
          settled = true
          const clean = output.replace(/\[[0-9;]*m/g, '').trim()
          if (code === 0) resolve(clean || '(no output)')
          else reject(new Error(`Exited with code ${code ?? 'null'}:\n${clean}`))
        })

        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          proc.kill('SIGKILL')
        })
      })()
    })
  },
}
