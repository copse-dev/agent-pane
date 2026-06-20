/** Heuristics for detecting when a shell command failed due to macOS project sandbox limits. */

export interface SandboxFailureDetection {
  likely: boolean
  reasons: string[]
}

const SANDBOX_FAILURE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /operation not permitted/i, reason: 'OS sandbox denied the operation' },
  {
    re: /(?:syscall|system call).*(?:denied|not permitted)/i,
    reason: 'system call blocked by sandbox',
  },
  { re: /\bdeny\b.*\b(?:network|file|process|mach)/i, reason: 'sandbox policy violation logged' },
  { re: /network.*(?:denied|blocked|not allowed|unavailable)/i, reason: 'network access blocked' },
  {
    re: /(?:EPERM|EACCES).*(?:connect|open|read|write|spawn|launch)/i,
    reason: 'permission error (EPERM/EACCES)',
  },
  { re: /seatbelt|sandbox.*denied/i, reason: 'sandbox restriction reported' },
  { re: /posix_spawnp failed/i, reason: 'process spawn blocked by sandbox' },
  {
    re: /Failed to spawn (?:shell|process|pty)/i,
    reason: 'shell/PTY spawn blocked by sandbox',
  },
]

const BROWSER_RUNNER_HINT = /\b(playwright|puppeteer|cypress|chromedriver|geckodriver|selenium)\b/i

const BROWSER_LAUNCH_FAILURE =
  /(?:browser(?:type)?\.launch|failed to launch|executable (?:doesn't|does not) exist|spawn.*ENOENT|connect ECONNREFUSED)/i

const DEV_TOOL_NOT_FOUND =
  /\/bin\/(?:ba)?sh: (?:node|npm|npx|pnpm|yarn|corepack): command not found/i

export function detectLikelySandboxFailure(
  output: string,
  exitCode: number | null,
): SandboxFailureDetection {
  if (exitCode === 0) return { likely: false, reasons: [] }

  const reasons: string[] = []
  for (const { re, reason } of SANDBOX_FAILURE_PATTERNS) {
    if (re.test(output)) reasons.push(reason)
  }

  if (BROWSER_RUNNER_HINT.test(output) && BROWSER_LAUNCH_FAILURE.test(output)) {
    reasons.push('browser/test runner likely needs network or paths outside the workspace')
  }

  if (exitCode === 127 && DEV_TOOL_NOT_FOUND.test(output)) {
    reasons.push('Node.js toolchain unavailable inside sandbox (often blocked home-directory installs)')
  }

  return { likely: reasons.length > 0, reasons: [...new Set(reasons)] }
}

export function formatUnsandboxedPromptBody(command: string, reasons: string[]): string {
  const detail = reasons.length ? reasons.join('; ') : 'sandbox restriction suspected'
  return (
    `This command failed inside the macOS project sandbox (${detail}).\n\n` +
    `${command}\n\n` +
    `Allow running it once without sandbox restrictions?`
  )
}
