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
 * Socket Firewall failing to stage its own binary are three *different*
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

const GIT_SUBCOMMAND = /(?:^|[\s;&|])git\s+(fetch|push|pull|clone|ls-remote|submodule)\b/

/** `git fetch` / `git push` / … from the command line, or a generic fallback. */
function gitNetworkOperation(command: string): string {
  const match = GIT_SUBCOMMAND.exec(command)
  return match?.[1] ? `git ${match[1]}` : 'git network access'
}

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
    // Observed (issue #1436): `npx prettier` failed with
    //   "[sfw] Failed to prepare firewall binary: EPERM"
    // Socket Firewall could not stage its own binary from inside the sandbox.
    // It worked on retry, so this is a one-time setup step, not a blocked
    // network or a broken environment.
    id: 'sfw-firewall-binary-eperm',
    pattern: /\[sfw]\s*Failed to prepare firewall binary: EPERM/,
    classify: () => ({
      operation: 'prepare firewall binary (sfw)',
      advice:
        'Socket Firewall could not prepare its firewall binary from inside the sandbox (EPERM) — ' +
        'this is a one-time setup step for the install scanner, not a blocked network.',
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
 * Whether a failed sandboxed command should be retried once with elevation
 * (issue #1436 point 1): a known signature matched, AND this attempt was not
 * already run with `expects_sandbox_block` — that flag already pulled the
 * escalation forward once, so a command that still fails with the same
 * signature has nothing left to retry into.
 */
export function sandboxDenialRetryClassification(
  output: string,
  command: string,
  alreadyExpectedSandboxBlock: boolean,
): SandboxDenialClassification | null {
  if (alreadyExpectedSandboxBlock) return null
  return classifySandboxDenial(output, command)
}

export type SandboxRetryEvidence = 'runner' | 'signature'

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

const GH_INVOCATION = /(?:^|[\s;&|])gh\s+\S/

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
  if (GIT_SUBCOMMAND.test(command)) return gitNetworkOperation(command)
  if (GH_INVOCATION.test(command)) return 'read ~/.config/gh'
  return null
}
