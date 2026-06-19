import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { getWorkspaceRoot } from '../services/workspace.ts'
import { requestApproval } from '../services/approval.ts'
import { getMainWindow } from '../windows/create-main-window.ts'

export const runShellTool: ToolDefinition = {
  name: 'run_shell',
  description:
    'Run a shell command in the workspace directory. Output is streamed to the conversation. Always requires user approval.',
  parameters: z.object({
    command: z.string().describe('Shell command to run'),
    timeout_ms: z.number().int().min(1000).max(300_000).optional().default(30_000),
  }),
  async execute({ command, timeout_ms }, signal) {
    const approved = await requestApproval({
      title: 'Run shell command?',
      body: command,
      type: 'shell',
    })
    if (!approved) return 'User rejected the shell command.'

    const cwd = getWorkspaceRoot()
    if (!cwd) return 'No workspace open.'

    const win = getMainWindow()

    return new Promise<string>((resolve, reject) => {
      // Use Node's built-in child_process rather than a native pty module:
      // node-pty must be ABI-matched to Electron and otherwise fails at spawn
      // time with posix_spawnp errors. We lose TTY behaviour but gain
      // reliability, and still stream output to the conversation.
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      const args = process.platform === 'win32' ? ['/c', command] : ['-c', command]

      const proc = spawn(shell, args, {
        cwd,
        env: process.env,
        stdio: 'pipe',
      })

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

      proc.on('error', (err) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(err)
        }
      })

      proc.on('close', (code) => {
        clearTimeout(timer)
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
    })
  },
}
