import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { TodoCheck } from '@shared/types/todo.ts'
import { runCommand } from './command-runner.ts'
import { getWorkspaceRoot } from './workspace.ts'

export interface TodoCheckResult {
  passed: boolean
  detail: string
}

export async function verifyTodoCheck(
  check: TodoCheck,
  signal: AbortSignal,
): Promise<TodoCheckResult> {
  const root = getWorkspaceRoot() ?? process.cwd()
  switch (check.kind) {
    case 'fileExists': {
      const path = join(root, check.path)
      try {
        await access(path)
        return { passed: true, detail: `File exists: ${check.path}` }
      } catch {
        return { passed: false, detail: `File not found: ${check.path}` }
      }
    }
    case 'typecheck': {
      const r = await runCommand('npm', ['run', 'typecheck'], { cwd: root, signal })
      const expect = 0
      const passed = r.code === expect
      return {
        passed,
        detail: passed
          ? 'typecheck passed'
          : `typecheck failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 500)}`,
      }
    }
    case 'shell': {
      const parts = check.command.trim().split(/\s+/)
      const cmd = parts[0]!
      const args = parts.slice(1)
      const r = await runCommand(cmd, args, { cwd: root, signal })
      const expect = check.expectExit ?? 0
      const passed = r.code === expect
      return {
        passed,
        detail: passed
          ? `Command succeeded: ${check.command}`
          : `Command failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 500)}`,
      }
    }
  }
}
