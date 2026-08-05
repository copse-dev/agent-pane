import { errorMessage } from '@shared/errors.ts'
import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getAgentExecutionRoot } from '../services/execution-root.ts'
import {
  afterSandboxedCommand,
  isProjectSandboxEnabled,
  sandboxViolationCountForCommand,
  spawnShellInProjectSandbox,
} from '../project-sandbox/index.ts'
import { shellRunsOutsideSandbox } from '../services/security/command-routing-config.ts'
import { detectSandboxFailure } from '../services/security/sandbox-failure.ts'
import {
  promptExpectedSandboxBlock,
  promptInstallSocketFirewall,
  promptUnsandboxedShell,
} from '../services/security/permission-gate.ts'
import {
  shellExpectedBlockEscalation,
  shellSandboxFailureShouldOfferUnsandboxedRetry,
} from '../services/security/permission-policy.ts'
import { envForRendererChildProcess } from '../services/exec/child-process-env.ts'
import {
  isSigpipeOnlyFailure,
  maybeEnablePipefail,
  pipefailWasInjected,
} from '../services/exec/shell-pipeline.ts'
import { leaseGitSshEnv } from '../services/ssh-workspace/git-ssh-env.ts'
import {
  isActiveSshWorkspace,
  resolveSshExecutionTargetForCwd,
} from '../services/ssh-workspace/execution-target.ts'
import { getSetting } from '../services/storage/settings.ts'
import { detectPackageInstall, wrapWithSocketFirewall } from '../services/security/safe-install.ts'
import {
  installSocketFirewall,
  isSocketFirewallAvailable,
} from '../services/security/socket-firewall.ts'
import {
  CappedOutputAccumulator,
  stripTerminalControlSequences,
} from '../services/exec/subprocess-output-cap.ts'
import { terminateProcessTree } from '../services/exec/subprocess-kill.ts'
import { adoptWorktreeChangesSince, captureWorktreeBaseline } from '../services/diff-queue.ts'
import { emitShellOutput } from '../services/exec/shell-output-context.ts'
import { getActiveRunThread } from '../services/thread-models.ts'
import { currentRunUsesGuardedYolo } from '../services/security/guarded-yolo.ts'

/** Shortest foreground timeout a caller may request. */
export const RUN_SHELL_MIN_TIMEOUT_MS = 1_000
/** Default foreground timeout when the caller omits `timeout_ms`. */
export const RUN_SHELL_DEFAULT_TIMEOUT_MS = 30_000
/**
 * Longest foreground timeout a caller may request. Raised from the original
 * 5-minute cap (issue #785) so a cold build (e.g. Xcode/SPM) can finish, while
 * still bounding foreground work — anything longer belongs in `run_background`.
 */
export const RUN_SHELL_MAX_TIMEOUT_MS = 30 * 60 * 1000

const RUN_SHELL_TIMEOUT_TOO_SMALL = `timeout_ms must be at least ${String(
  RUN_SHELL_MIN_TIMEOUT_MS,
)}ms.`
const RUN_SHELL_TIMEOUT_TOO_LARGE =
  `timeout_ms may not exceed ${String(RUN_SHELL_MAX_TIMEOUT_MS)}ms (` +
  `${String(RUN_SHELL_MAX_TIMEOUT_MS / 60_000)} minutes). For dev servers, watchers, or ` +
  `intentionally unbounded work, use run_background instead of a longer foreground timeout.`

interface ShellRunResult {
  output: string
  exitCode: number
  sandboxViolationCount?: number
  /** The sandbox wrapper process itself failed to start (child 'error' event). */
  spawnFailed?: boolean
}

async function runShellOnce(
  command: string,
  cwd: string,
  timeout_ms: number,
  signal: AbortSignal,
  unsandboxed: boolean,
  env: NodeJS.ProcessEnv,
): Promise<ShellRunResult> {
  return new Promise<ShellRunResult>((resolve, reject) => {
    void (async (): Promise<void> => {
      let proc
      try {
        proc = await spawnShellInProjectSandbox(command, {
          cwd,
          env,
          stdio: 'pipe',
          signal,
          unsandboxed,
        })
      } catch (err) {
        // Wrapping the command in the sandbox failed (runner-side, not command
        // output). For a sandboxed run, surface it as spawnFailed so an unsandboxed
        // retry can be offered (issue #104); for an unsandboxed run it's a real error.
        if (!unsandboxed) {
          const message = errorMessage(err)
          resolve({ output: message, exitCode: -1, spawnFailed: true })
        } else {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        return
      }

      const outputAcc = new CappedOutputAccumulator()
      let settled = false
      let cancelKill: (() => void) | undefined
      const stream = (data: Buffer): void => {
        const toStream = outputAcc.append(data.toString())
        if (toStream) emitShellOutput(toStream)
      }
      proc.stdout?.on('data', stream)
      proc.stderr?.on('data', stream)

      const onAbort = (): void => {
        clearTimeout(timer)
        cancelKill = terminateProcessTree(proc)
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        cancelKill?.()
        signal.removeEventListener('abort', onAbort)
      }

      const timer = setTimeout(() => {
        cancelKill = terminateProcessTree(proc)
        if (!settled) {
          settled = true
          signal.removeEventListener('abort', onAbort)
          reject(new Error(`Command timed out after ${String(timeout_ms)}ms`))
        }
      }, timeout_ms)

      const sandboxViolationCount = (): number =>
        unsandboxed ? 0 : sandboxViolationCountForCommand(command)

      const finish = (): void => {
        if (!unsandboxed) afterSandboxedCommand()
      }

      proc.on('error', (err) => {
        cleanup()
        const violationCount = sandboxViolationCount()
        finish()
        if (settled) return
        settled = true
        // A child 'error' (e.g. the sandbox wrapper binary failed to launch) is a
        // runner-side failure, not command-controlled output. Surface it as a result
        // with spawnFailed so an unsandboxed retry can be offered (issue #104), but
        // only when this was a sandboxed run.
        if (!unsandboxed) {
          const message = errorMessage(err)
          resolve({
            output: message,
            exitCode: -1,
            sandboxViolationCount: violationCount,
            spawnFailed: true,
          })
          return
        }
        reject(err instanceof Error ? err : new Error(String(err)))
      })

      proc.on('close', (code) => {
        cleanup()
        const violationCount = sandboxViolationCount()
        finish()
        if (settled) return
        settled = true
        resolve({
          output: outputAcc.toString(),
          exitCode: code ?? 0,
          sandboxViolationCount: violationCount,
        })
      })

      signal.addEventListener('abort', onAbort)
    })()
  })
}

async function maybeRetryUnsandboxed(
  command: string,
  cwd: string,
  timeout_ms: number,
  signal: AbortSignal,
  result: ShellRunResult,
  env: NodeJS.ProcessEnv,
  guardedYolo: boolean,
): Promise<ShellRunResult | 'declined' | null> {
  if (!isProjectSandboxEnabled()) return null
  if (!shellSandboxFailureShouldOfferUnsandboxedRetry(command, cwd)) {
    return null
  }
  // Decide purely from runner-side signals (recorded sandbox violations / wrapper
  // spawn failure) — never from the command's own stdout/stderr (issue #104).
  const detection = detectSandboxFailure({
    exitCode: result.exitCode,
    violationCount: result.sandboxViolationCount ?? sandboxViolationCountForCommand(command),
    spawnFailed: result.spawnFailed ?? false,
  })
  if (!detection.likely) return null
  const approved = guardedYolo || (await promptUnsandboxedShell(command, detection.reasons, signal))
  if (!approved) return 'declined'
  return runShellOnce(command, cwd, timeout_ms, signal, true, env)
}

const SHELL_INVOCATION =
  process.platform === 'win32' ? { path: 'cmd', cArg: '/c' } : { path: '/bin/sh', cArg: '-c' }

const winQuote = (value: string): string => `"${value.replace(/"/g, '""')}"`

type PreparedCommand =
  { command: string; env: NodeJS.ProcessEnv; banner: string } | { refused: string }

/**
 * When a command performs a package install, route the whole command through
 * Socket Firewall once (installing sfw first if needed) so the package manager
 * it invokes is proxied. JS managers additionally get `npm_config_ignore_scripts`
 * to block install lifecycle scripts. Non-install commands pass through untouched.
 */
async function prepareCommand(command: string, signal: AbortSignal): Promise<PreparedCommand> {
  const baseEnv = process.env
  if (!getSetting<boolean>('safeInstallEnabled', true)) {
    return { command, env: baseEnv, banner: '' }
  }

  const detection = detectPackageInstall(command)
  if (!detection.isInstall) return { command, env: baseEnv, banner: '' }

  if (!isSocketFirewallAvailable()) {
    const approved = await promptInstallSocketFirewall(command)
    if (!approved) {
      return {
        refused:
          'Package install cancelled: Socket Firewall (sfw) is required to scan packages and was not installed.',
      }
    }
    const installed = await installSocketFirewall(signal)
    if (!installed) {
      return { refused: 'Package install cancelled: Socket Firewall (sfw) installation failed.' }
    }
  }

  const quote = process.platform === 'win32' ? winQuote : undefined
  const wrapped = wrapWithSocketFirewall(command, SHELL_INVOCATION, quote)
  const env: NodeJS.ProcessEnv = detection.jsManager
    ? { ...baseEnv, npm_config_ignore_scripts: 'true' }
    : baseEnv
  const notes = [
    'scanned by Socket Firewall (sfw)',
    ...(detection.jsManager ? ['install scripts disabled (npm_config_ignore_scripts)'] : []),
  ]
  const banner = `[safe-install] ${notes.join('; ')}\n$ ${wrapped}\n`
  emitShellOutput(banner)
  return { command: wrapped, env, banner }
}

function formatShellSuccess(result: ShellRunResult): string {
  const clean = stripTerminalControlSequences(result.output).trim()
  return clean || '(no output)'
}

function formatShellFailure(result: ShellRunResult): Error {
  const clean = stripTerminalControlSequences(result.output).trim()
  return new Error(`Exited with code ${String(result.exitCode)}:\n${clean}`)
}

export const runShellTool = defineTool({
  name: 'run_shell',
  description:
    'Run a shell command for tests, builds, installs, and other tasks not covered by a dedicated tool — not for reading files or searching code (use read_file/search tools or explore). ' +
    'Output is streamed to the conversation. ' +
    'Commands contained within the sandbox auto-run; network or outside-workspace access (e.g. gh, curl, git push) prompts for approval and runs outside the sandbox when the macOS project sandbox is active. ' +
    'If a sandbox-contained command fails because the sandbox blocks filesystem/process access (e.g. Playwright), the user may approve running it once outside the sandbox. ' +
    'If you already expect a command to need the network or files outside the workspace (e.g. gh, cloud CLIs), set expects_sandbox_block so the user is asked up front instead of after a failed sandboxed attempt. ' +
    'Do not read credential files — .env and its variants, ~/.ssh, ~/.aws, keychains — inside or outside the workspace; ask the user for the value you need instead. ' +
    'Package-manager installs (npm/pnpm/yarn/pip/uv/cargo/npx) are automatically run through Socket Firewall to scan for malicious packages, with install lifecycle scripts disabled. ' +
    'A foreground command may run up to 30 minutes (timeout_ms); for dev servers, watchers, or intentionally unbounded processes use run_background instead of a long timeout. ' +
    "Piping a command through `tail`/`head` normally masks the earlier command's exit code; run_shell enables pipefail so a failing pipeline is still reported as failed, while a producer that only stopped because `head` closed the pipe early still counts as success.",
  parameters: z.object({
    command: z.string().describe('Shell command to run'),
    timeout_ms: z
      .number()
      .int()
      .min(RUN_SHELL_MIN_TIMEOUT_MS, RUN_SHELL_TIMEOUT_TOO_SMALL)
      .max(RUN_SHELL_MAX_TIMEOUT_MS, RUN_SHELL_TIMEOUT_TOO_LARGE)
      .optional()
      .default(RUN_SHELL_DEFAULT_TIMEOUT_MS)
      .describe(
        `Foreground timeout in milliseconds (default ${String(
          RUN_SHELL_DEFAULT_TIMEOUT_MS,
        )}, max ${String(RUN_SHELL_MAX_TIMEOUT_MS)}). On timeout the process tree is killed. ` +
          `Use run_background for dev servers, watchers, or intentionally unbounded processes ` +
          `rather than a long foreground timeout.`,
      ),
    expects_sandbox_block: z
      .boolean()
      .optional()
      .describe(
        'Set true when you already expect this command to need access the sandbox blocks — network ' +
          '(e.g. gh, cloud CLIs, nc) or files outside the workspace — so the user is asked to run it ' +
          'outside the sandbox up front rather than after it fails inside. Only affects commands that ' +
          'might reach outside the sandbox; fully local commands run sandboxed regardless of this flag.',
      ),
  }),
  async execute({ command, timeout_ms, expects_sandbox_block }, signal) {
    const cwd = getAgentExecutionRoot()
    if (!cwd) return 'No workspace open.'

    const prepared = await prepareCommand(command, signal)
    if ('refused' in prepared) return prepared.refused
    const { command: finalCommand, env, banner } = prepared
    const withBanner = (output: string): string => (banner ? `${banner}\n${output}` : output)

    // Enable pipefail for real pipelines so a failing producer piped into
    // `tail`/`head` surfaces as a non-zero exit instead of being masked as
    // success (issue #787) — which also restores the runner-verified unsandboxed
    // retry offer. Only injected where the shell honors pipefail (see
    // maybeEnablePipefail): remote and non-macOS shells preserve current behavior.
    // The same transformed command is used for the sandboxed run and any approved
    // unsandboxed retry so both share one shell, command, and violation attribution.
    const isRemote = isActiveSshWorkspace() || resolveSshExecutionTargetForCwd(cwd) !== null
    const executedCommand = maybeEnablePipefail(finalCommand, {
      platform: process.platform,
      isRemote,
    })
    const pipefailInjected = pipefailWasInjected(finalCommand, executedCommand)

    // Decide sandbox vs unsandboxed from the RAW command (not the sfw-wrapped
    // finalCommand) so this matches the permission gate's decision exactly: a
    // trusted allow-listed command runs unsandboxed with no prompt, otherwise the
    // existing external-command heuristic applies. shellRunsOutsideSandbox is the
    // single source of truth shared with the gate and todo verification.
    const sandboxEnabled = isProjectSandboxEnabled()
    const guardedYolo = currentRunUsesGuardedYolo(getActiveRunThread())
    let outsideSandbox = shellRunsOutsideSandbox(command)

    // If the agent declared up front that it expects the sandbox to block this
    // command, pull the escalation prompt forward instead of running inside the
    // sandbox and offering an unsandboxed retry only after a real block. Bounded to
    // the 'ambiguous' verdict (see shellExpectedBlockEscalation): a hard-'external'
    // command already prompts + runs outside here, and a fully-contained command
    // must still earn its escape from a runner-verified block, never this hint.
    // Analyze the same RAW command as the outsideSandbox decision above, so the
    // hint can never escalate a command whose real verdict is fully-contained.
    let suppressUnsandboxedRetry = false
    if (!outsideSandbox && expects_sandbox_block === true) {
      const escalation = shellExpectedBlockEscalation(command, cwd, sandboxEnabled)
      if (escalation.eligible) {
        if (
          guardedYolo ||
          (await promptExpectedSandboxBlock(command, escalation.reasons, signal))
        ) {
          outsideSandbox = true
        } else {
          // The user declined the up-front escalation. Still run the command inside
          // the sandbox, but don't nag with the reactive retry prompt on failure —
          // they just answered that exact question for this command.
          suppressUnsandboxedRetry = true
        }
      }
    }

    const containmentBanner = guardedYolo
      ? `[Guarded YOLO · ${outsideSandbox || !sandboxEnabled ? 'unsandboxed' : 'project sandbox'}]\n`
      : ''
    if (containmentBanner) {
      emitShellOutput(containmentBanner)
    }

    // Strip LLM API keys (and other secrets) from the child env so a compromised
    // command — especially an unsandboxed retry with full network — cannot exfiltrate
    // them (issue #108). prepareCommand's own additions (e.g. npm_config_ignore_scripts)
    // are preserved on top. Git-over-SSH askpass vars are merged so `sh -c "git push"`
    // can prompt for passphrases / host keys instead of failing in BatchMode.
    const gitSsh = leaseGitSshEnv(envForRendererChildProcess(env))
    const childEnv = gitSsh.env

    // Bracket the run so any file this agent-triggered command changes (e.g. a
    // formatter rewriting a file Copse just edited) is adopted as Copse-owned —
    // keeping the worktree "clean" for direct edits on the next turn. Runs in a
    // finally because a command can change files even when it exits non-zero or
    // the runner throws. Scoped to the command's real effects by the baseline diff.
    const baseline = await captureWorktreeBaseline()
    try {
      const result = await runShellOnce(
        executedCommand,
        cwd,
        timeout_ms,
        signal,
        outsideSandbox,
        childEnv,
      )

      // A pipeline whose only non-zero status is a SIGPIPE'd producer succeeded:
      // the downstream `head`/`grep -m` closed the pipe because it already had
      // everything it asked for. Reporting that as a failure is the mirror-image
      // of the masking pipefail was added to prevent (issue #787), and costs more
      // — it teaches the agent that its own working diagnostics are broken.
      const succeeded = (r: ShellRunResult): boolean =>
        r.exitCode === 0 || isSigpipeOnlyFailure(r.exitCode, pipefailInjected)

      if (succeeded(result)) return `${containmentBanner}${withBanner(formatShellSuccess(result))}`

      if (!suppressUnsandboxedRetry) {
        const retry = await maybeRetryUnsandboxed(
          executedCommand,
          cwd,
          timeout_ms,
          signal,
          result,
          childEnv,
          guardedYolo,
        )
        if (retry === 'declined') return 'User declined to run outside the sandbox.'
        if (retry) {
          if (succeeded(retry)) {
            const retryBanner = guardedYolo ? '[Guarded YOLO · unsandboxed retry]\n' : ''
            return `${retryBanner}${withBanner(formatShellSuccess(retry))}`
          }
          throw formatShellFailure(retry)
        }
      }

      throw formatShellFailure(result)
    } finally {
      gitSsh.release()
      await adoptWorktreeChangesSince(baseline)
    }
  },
})
