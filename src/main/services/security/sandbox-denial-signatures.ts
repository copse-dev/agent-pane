/**
 * Classify a failed `run_shell` command's own output against known sandbox-denial
 * signatures, so a first-time denial gets retried once with elevation instead of
 * being handed to the model as a raw, opaque failure (issue #1436).
 *
 * The problem this exists for: `detectSandboxFailure` (sandbox-failure.ts) only
 * sees runner-side signals — the OS sandbox's own violation counter and wrapper
 * spawn failures — which is deliberately narrow (issue #104: never trust a
 * command's stdout/stderr to grant an escape). But not every denial in this
 * codebase trips that counter. A `git fetch` blocked by the container's network
 * egress broker, `gh` failing to read its own config outside the workspace, and
 * a package install unable to download from inside the sandbox are three *different*
 * subsystems, none of which increments the seatbelt/ASRT violation count, so
 * `detectSandboxFailure` never fires for them and no retry is ever offered.
 *
 * SECURITY: this module only ever produces *advisory text and an operation
 * name* — the same tolerance `sandbox-denial-advice.ts` already documents for
 * text derived from a model-authored command. It does NOT reopen #104: matching
 * one of these signatures never grants a host-sandbox escape by itself. A retry
 * that would leave the host sandbox must still use the same approval prompt as
 * a user-requested elevation (`promptUnsandboxedShell` /
 * `promptExpectedSandboxBlock`). Guarded YOLO may bypass that prompt only for
 * the runner's non-forgeable evidence, never for one of these signatures. An
 * unattended container can retry without a person because it stays inside the
 * same disposable guest rather than escaping onto the host. Thus a forged
 * signature can cause only an extra prompt or a rerun inside that guest — the
 * same trust level as the model's own `expects_sandbox_block` hint.
 */

import {
  SHELL_LANGUAGE_INTERPRETERS,
  commandName,
  shellSegments,
  unwrapWrappers,
} from './shell-argv.ts'

export interface SandboxDenialClassification {
  /** Stable operation descriptor, independent of which tool ran the command (issue #1436 point 2). */
  operation: string
  /** Operation-specific sentence for the model — never a blanket "network"/"sandbox" claim (point 3). */
  advice: string
}

interface SandboxDenialSignature {
  /** Short id for tests/logs. */
  id: string
  /** Matched against the command's own stdout+stderr. */
  pattern: RegExp
  /** Derives the operation descriptor and advice from the matched command. */
  classify: (command: string) => SandboxDenialClassification
}

const GIT_NETWORK_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'fetch',
  'push',
  'pull',
  'clone',
  'ls-remote',
  'submodule',
])

/** Git global options whose value is a separate argument (`git -C dir fetch`). */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
])

/**
 * A shell's `-c`, alone or ending a cluster of single-letter options (`bash -lc`,
 * `sh -ec`). The shared `inlineCodeBody` matches only the exact flag, and its
 * `-e` means inline code to node, not errexit to a shell.
 */
const SHELL_INLINE_CODE_FLAG = /^-[a-z]*c$/

/** PowerShell's inline-code flag — not a single-letter bundle, so `SHELL_INLINE_CODE_FLAG` misses it. */
const POWERSHELL_INLINE_CODE_FLAG = /^-command$/i

/** Shell options whose value is a separate argument (`bash -o pipefail -c …`). */
const SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-o',
  '+o',
  '-O',
  '+O',
  '--rcfile',
  '--init-file',
])

/**
 * The command string a shell interpreter's argv runs with `-c`, or null. A shell
 * reads its own options only up to the first operand, so in `bash script.sh -c x`
 * the `-c` is an argument to the script and no inline code runs.
 */
function shellInlineBody(argv: readonly string[]): string | null {
  for (let index = 1; index < argv.length - 1; index += 1) {
    const token = argv[index] ?? ''
    if (SHELL_INLINE_CODE_FLAG.test(token) || POWERSHELL_INLINE_CODE_FLAG.test(token)) {
      return argv[index + 1] ?? null
    }
    if (SHELL_VALUE_OPTIONS.has(token)) {
      index += 1
      continue
    }
    if (token === '--' || !/^[-+]/.test(token)) return null
  }
  return null
}

/**
 * Reserved words that only introduce a conditional or loop branch, never a
 * command in their own right. The shell parser has no notion of these — they
 * surface as an ordinary argv[0] once a keyword lands at the start of its own
 * segment (its own line, or right after `;`/`)`), which is exactly where a
 * shell itself only recognises them as reserved words. Their presence means
 * at least one segment in this command might not run, so `commandArgvs` can
 * no longer promise every argv it returns actually executes.
 */
const CONDITIONAL_KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'case',
  'esac',
  'for',
  'while',
  'until',
  'do',
  'done',
  'select',
])

/**
 * Every argv that runs as a command, after wrapper unwrapping (`env FOO=1 git
 * push`, `timeout 5 gh …`), including the body of `sh -c '…'`. Built from the
 * shell parser alone — never the raw-text fallback — so a program name inside a
 * quoted argument (`grep -rn "then git fetch" docs`) or after another command
 * (`echo git push`) is data, not a command, and predicts no operation.
 *
 * Returns no argvs at all once a conditional/loop keyword shows up as a
 * segment's own head (`if ...; then\n  git fetch\nfi`, `case $1 in start)
 * git fetch ;; esac`): this module cannot know which branch would actually
 * run without executing it, and for a cache that preemptively fronts an
 * "outside the sandbox?" prompt, a missed match is a quiet no-op while a
 * false one is the exact bug (#1436) this predicts around. Reactive
 * classification of an already-failed command degrades the same way, to the
 * generic egress-proxy label.
 */
function commandArgvs(command: string): string[][] {
  const argvs: string[][] = []
  for (const segment of shellSegments(command, false)) {
    const argv = unwrapWrappers(segment)
    if (argv.length === 0) continue
    if (CONDITIONAL_KEYWORDS.has(commandName(argv[0]))) return []
    argvs.push(argv)
    if (SHELL_LANGUAGE_INTERPRETERS.has(commandName(argv[0]))) {
      const body = shellInlineBody(argv)
      if (body !== null) argvs.push(...commandArgvs(body))
    }
  }
  return argvs
}

/** The subcommand of a `git` argv, skipping global options and their values. */
function gitSubcommand(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index] ?? ''
    if (GIT_VALUE_OPTIONS.has(token)) {
      index++
      continue
    }
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

/**
 * `git fetch` / `git push` / … for a git network subcommand in command position,
 * `git network access` for any other git invocation, or null when no git
 * command runs at all.
 */
function gitNetworkOperation(command: string): string | null {
  let ranGit = false
  for (const argv of commandArgvs(command)) {
    if (commandName(argv[0]) !== 'git') continue
    ranGit = true
    const subcommand = gitSubcommand(argv)
    if (subcommand !== undefined && GIT_NETWORK_SUBCOMMANDS.has(subcommand)) {
      return `git ${subcommand}`
    }
  }
  return ranGit ? 'git network access' : null
}

/** Operation name for a CONNECT-tunnel denial whose command runs no git. */
const EGRESS_NETWORK_OPERATION = 'network access through the egress proxy'

/**
 * Named table of known sandbox-denial signatures. Each entry cites the exact
 * error observed in issue #1436 so a future signature can be added the same way:
 * quote the real string, name the real operation, never a category.
 */
export const SANDBOX_DENIAL_SIGNATURES: readonly SandboxDenialSignature[] = [
  {
    // Observed (issue #1436): `git fetch origin main` failed with
    //   "fatal: unable to access '...': CONNECT tunnel failed, response 403"
    // The container's network egress broker denied the CONNECT tunnel — a
    // different subsystem from the OS sandbox's own violation counter, so
    // `detectSandboxFailure` never sees it. The identical command with `git
    // push` succeeded unprompted right after, so the operation must name the
    // specific git subcommand, never "the network".
    id: 'network-egress-connect-403',
    pattern: /CONNECT tunnel failed, response 403/,
    classify: (command: string): SandboxDenialClassification => {
      const operation = gitNetworkOperation(command)
      if (operation === null) {
        return {
          operation: EGRESS_NETWORK_OPERATION,
          advice:
            'This command needs network access that was denied (CONNECT tunnel failed, response ' +
            '403). This is specific to the host it tried to reach, not a general network outage.',
        }
      }
      return {
        operation,
        advice:
          `${operation} needs network access that was denied (CONNECT tunnel failed, response ` +
          '403). This is specific to this operation, not a general network outage — other network ' +
          'operations (e.g. a different git remote action) may still work.',
      }
    },
  },
  {
    // Observed (issue #1436): `gh pr create` failed with
    //   "open ~/.config/gh/config.yml: operation not permitted"
    // `gh` reads its own config outside the workspace before doing anything
    // else, so this fires for any `gh` subcommand, not just `pr create`. The
    // identical command with `expects_sandbox_block: true` succeeded immediately.
    id: 'gh-config-read',
    pattern:
      /open .*\.config[/\\]gh[/\\]config\.ya?ml.*(?:operation not permitted|permission denied)/i,
    classify: () => ({
      operation: 'read ~/.config/gh',
      advice:
        'gh could not read its own config at ~/.config/gh (operation not permitted) — this needs ' +
        'read access outside the workspace, not the network, and is specific to gh.',
    }),
  },
  {
    // The package firewall wraps every detected install. Inside the contained
    // sandbox it either cannot open its loopback proxy (macOS: it then runs the
    // command with registry downloads disabled, package-firewall/run.ts) or can
    // open it but reach nothing upstream (Linux: a private network namespace).
    // If the command then fails, it needed a download — which only a run
    // outside the sandbox can make, still behind the firewall.
    id: 'package-firewall-loopback-denied',
    pattern:
      /\[safe-install] (?:cannot listen on loopback here \((?:EPERM|EACCES)\)|could not reach \S+)/,
    classify: () => ({
      operation: 'download packages',
      advice:
        'Packages cannot be downloaded from inside the sandbox — this command needs to ' +
        'download packages, which needs network access outside the sandbox.',
    }),
  },
]

/**
 * Match a failed command's own output against the known signature table.
 * Returns null when nothing recognisable matched — an ordinary, unclassified
 * failure must be returned to the model unchanged.
 */
export function classifySandboxDenial(
  output: string,
  command: string,
): SandboxDenialClassification | null {
  for (const signature of SANDBOX_DENIAL_SIGNATURES) {
    if (signature.pattern.test(output)) return signature.classify(command)
  }
  return null
}

/**
 * Whether a failed sandbox-contained command matched a known denial signature
 * and should be considered for one elevated retry (issue #1436 point 1). The
 * caller owns the attempt-provenance guard: an already-unsandboxed failure must
 * never reach this classifier as a retry candidate.
 */
export function sandboxDenialRetryClassification(
  output: string,
  command: string,
): SandboxDenialClassification | null {
  return classifySandboxDenial(output, command)
}

export type SandboxRetryEvidence = 'runner' | 'signature'
export type SandboxForwardEscalationSource = 'model-hint' | 'denial-cache'

/**
 * Whether a retry may bypass its approval prompt in an explicitly unattended
 * mode. Guarded YOLO may trust the sandbox runner's own non-forgeable evidence,
 * but never a signature copied from command output: a sandboxed executable can
 * print that text itself and must not thereby earn an unsandboxed rerun. An
 * unattended container has no host sandbox to escape, so either evidence kind
 * retries only inside the same disposable guest.
 */
export function sandboxRetryMaySkipApproval(
  evidence: SandboxRetryEvidence,
  guardedYolo: boolean,
  unattendedContainer: boolean,
): boolean {
  return unattendedContainer || (evidence === 'runner' && guardedYolo)
}

/**
 * Whether an up-front escalation may bypass approval. Guarded YOLO may trust the
 * model's explicit hint, but a remembered denial came from the same forgeable
 * command output as a first reactive signature match. Reusing that cache must
 * therefore preserve the original approval boundary. An unattended container
 * may advance either source because the command stays in its disposable guest.
 */
export function sandboxForwardEscalationMaySkipApproval(
  source: SandboxForwardEscalationSource,
  guardedYolo: boolean,
  unattendedContainer: boolean,
): boolean {
  return unattendedContainer || (source === 'model-hint' && guardedYolo)
}

/** One-line, greppable note so a signature-triggered retry stays visible in the transcript. */
export const SANDBOX_DENIAL_RETRY_NOTE = 'first attempt denied by sandbox, retried with elevation'

/** Prefix a successful retry's output with the observability note (issue #1436). */
export function prefixWithSandboxRetryNote(output: string): string {
  return `[${SANDBOX_DENIAL_RETRY_NOTE}]\n${output}`
}

/**
 * One-line note for the OTHER shape of observability the issue asks for: this
 * exact operation was already confirmed denied earlier in the thread (see
 * `denied-operations.ts`), so the sandboxed attempt was skipped entirely rather
 * than repeating a probe whose answer is already known.
 */
export const SANDBOX_DENIAL_CACHE_SKIP_NOTE =
  'operation already denied by sandbox earlier in this thread, skipped sandboxed attempt'

export function prefixWithSandboxCacheSkipNote(output: string): string {
  return `[${SANDBOX_DENIAL_CACHE_SKIP_NOTE}]\n${output}`
}

/**
 * Best-effort operation descriptor derived from the COMMAND alone (never its
 * output), for the cases where the shape of the command already predicts which
 * operation a denial would name. Used to consult the per-thread denied-operation
 * cache *before* running a command, so a second attempt at an already-confirmed
 * denial does not repeat the sandboxed probe (issue #1436 point 2). Returns null
 * when the command's shape does not predict a known operation — those commands
 * are only ever classified reactively, from an actual failure's output.
 */
export function operationDescriptorForCommand(command: string): string | null {
  const gitOperation = gitNetworkOperation(command)
  if (gitOperation !== null && gitOperation !== 'git network access') return gitOperation
  if (commandArgvs(command).some((argv) => commandName(argv[0]) === 'gh')) {
    return 'read ~/.config/gh'
  }
  return null
}
