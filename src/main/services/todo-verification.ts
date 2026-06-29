import { errorMessage } from '@shared/errors.ts'
import { access } from 'node:fs/promises'
import type { TodoCheck } from '@shared/types/todo.ts'
import { isProjectSandboxEnabled } from '../project-sandbox/index.ts'
import { runCommand } from './command-runner.ts'
import { ensureShellCommandPermitted } from './permission-gate.ts'
import { shellRequiresOutsideSandbox } from './permission-policy.ts'
import { getWorkspaceRoot, resolveWorkspacePath } from './workspace.ts'

export interface TodoCheckResult {
  passed: boolean
  detail: string
}

async function rejectIfShellDenied(command: string): Promise<TodoCheckResult | null> {
  const permitted = await ensureShellCommandPermitted(command)
  if (!permitted) {
    return { passed: false, detail: 'User rejected shell command for todo verification' }
  }
  return null
}

export async function verifyTodoCheck(
  check: TodoCheck,
  signal: AbortSignal,
): Promise<TodoCheckResult> {
  const root = getWorkspaceRoot() ?? process.cwd()

  switch (check.kind) {
    case 'fileExists': {
      let absPath: string
      try {
        absPath = resolveWorkspacePath(check.path)
      } catch (err) {
        const msg = errorMessage(err)
        return { passed: false, detail: msg }
      }
      try {
        await access(absPath)
        return { passed: true, detail: `File exists: ${check.path}` }
      } catch {
        return { passed: false, detail: `File not found: ${check.path}` }
      }
    }
    case 'typecheck': {
      const rejected = await rejectIfShellDenied('npm run typecheck')
      if (rejected) return rejected
      const r = await runCommand('npm', ['run', 'typecheck'], {
        cwd: root,
        signal,
        useRendererEnv: true,
      })
      const expect = 0
      const passed = r.code === expect
      return {
        passed,
        detail: passed
          ? 'typecheck passed'
          : `typecheck failed (exit ${String(r.code)}): ${(r.stderr || r.stdout).slice(0, 500)}`,
      }
    }
    case 'shell': {
      const rejected = await rejectIfShellDenied(check.command)
      if (rejected) return rejected

      const parts = check.command.trim().split(/\s+/)
      const [cmd, ...args] = parts
      if (!cmd) return { passed: false, detail: 'empty shell command' }
      const workspaceRoot = getWorkspaceRoot()
      const unsandboxed = shellRequiresOutsideSandbox(
        check.command,
        workspaceRoot,
        isProjectSandboxEnabled(),
      )
      const r = await runCommand(cmd, args, {
        cwd: root,
        signal,
        unsandboxed,
        useRendererEnv: true,
      })
      const expect = check.expectExit ?? 0
      const passed = r.code === expect
      return {
        passed,
        detail: passed
          ? `Command succeeded: ${check.command}`
          : `Command failed (exit ${String(r.code)}): ${(r.stderr || r.stdout).slice(0, 500)}`,
      }
    }
  }
}
