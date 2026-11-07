import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { invalidatePlanUsageCache } from './plan-usage-bridge.ts'

const execFileAsync = promisify(execFile)
let pendingSignIn: Promise<{ ok: boolean; error?: string }> | null = null

/** Claude owns the OAuth exchange and credential store; Copse only checks its result. */
export function signInToClaude(): Promise<{ ok: boolean; error?: string }> {
  if (pendingSignIn) return pendingSignIn
  pendingSignIn = (async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await execFileAsync('claude', ['auth', 'login'], {
        cwd: homedir(),
        encoding: 'utf8',
        timeout: 300_000,
        maxBuffer: 64 * 1024,
      })
      const { stdout } = await execFileAsync('claude', ['auth', 'status'], {
        cwd: homedir(),
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      })
      const status = safeJsonParse(stdout, decodeWithSchema(z.object({ authMethod: z.string() })))
      if (status?.authMethod !== 'claude.ai') {
        return {
          ok: false,
          error: 'Claude is using an API key or token, not a Claude subscription sign-in.',
        }
      }
      invalidatePlanUsageCache()
      return { ok: true }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { ok: false, error: 'Claude Code is not installed or is not on Copse’s PATH.' }
      }
      return {
        ok: false,
        error:
          'Claude sign-in did not complete. Try again, or run claude auth login in a terminal.',
      }
    }
  })().finally(() => {
    pendingSignIn = null
  })
  return pendingSignIn
}
