import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { parse as parseShellCommand } from 'shell-quote'

export type ScopeVerdict = 'sandbox' | 'external' | 'ambiguous'

export interface ShellScopeAnalysis {
  verdict: ScopeVerdict
  reasons: string[]
}

/**
 * Heuristic shell-command classifier for permission prompts — not a security boundary.
 * On macOS, project seatbelt is the real confinement; elsewhere, users must approve
 * commands that look external. Evasion (substitution, encoding, uncommon tools) is
 * possible; patterns here reduce obvious false auto-runs only.
 *
 * Classification is regex-first, with an ADDITIVE shell-quote tokenization layer
 * (see `tokenBasedExternalReasons`) that reinforces the most fragile checks by
 * keying off `argv[0]`. The token layer can only ever add reasons / escalate; it
 * never removes a reason or downgrades a verdict, so it cannot make the gate more
 * permissive than the regex path alone.
 */

// A command-invocation position: start of the string, or immediately after a
// shell separator (pipe, semicolon, &&/||, subshell open, newline). Anchoring a
// bare command name here lets us match e.g. `gh` the binary without also matching
// `gh` as a substring of a path or argument like `services/gh-pr-service.ts`
// (a read-only grep on a gh-* filename was misclassified as a GitHub CLI call).
const CMD_POS = String.raw`(?:^|[\n|;&(])\s*`

// Direct execution of a workspace-relative file (`./build`, `../tool`, `bin/x`).
// The agent can author and `chmod +x` such a file, so its contents are opaque to
// this classifier (and to the file-blind safety classifier) — a hard escape even
// under the sandbox, exactly like `node ./x.js`. Shared verbatim between the regex
// entry and the token layer so the two dedupe against each other. (#581)
const REASON_LOCAL_EXECUTABLE =
  'executes an in-workspace file directly (contents opaque to analysis)'

// Commands that clearly reach outside the workspace or network.
//
// `ambiguous: true` marks fuzzy "may reach" matchers — short/overloaded command
// names that often appear as harmless local subcommands (e.g. `gh`, `nc`, the
// `aws|gcloud|az` catch-all, `open <url>`). When macOS seatbelt is the real
// boundary, these auto-run *inside* the sandbox and rely on the failure→retry
// escalation if the OS actually blocks them, instead of prompting upfront on a
// guess. Without an OS sandbox they still prompt, like any external command.
const EXTERNAL_PATTERNS: Array<{ re: RegExp; reason: string; ambiguous?: boolean }> = [
  { re: /\bcurl\b|\bwget\b/i, reason: 'network download (curl/wget)' },
  // The standalone `fetch` downloader is anchored to a command position so it fires
  // on `fetch <url>` but NOT on `git fetch` (where `fetch` is git's subcommand — a
  // network *read* handled by the ambiguous git matcher below). (#500)
  { re: new RegExp(`${CMD_POS}fetch\\b`, 'i'), reason: 'network download (fetch)' },
  {
    // `dlx` is intentionally absent: it's an ephemeral runner, handled by the
    // ambiguous ephemeral-runner matcher below so it gets the same in-sandbox
    // treatment as npx/bunx rather than a hard prompt. (#500)
    re: /\b(npm|yarn|pnpm|bun)\s+(i|in|install|ci|update|upgrade|publish|add|exec|create)\b/i,
    reason: 'package install/update (may fetch + run code from network)',
  },
  // Ephemeral package runners auto-fetch and execute the *latest* (typo-squattable)
  // package with no pinning or integrity check — a supply-chain RCE surface (#174).
  // Marked `ambiguous` so that, when an OS sandbox is the real boundary, they
  // auto-run *inside* it (where Socket Firewall wraps the install and seatbelt
  // confines FS/network) instead of prompting up front: a runner that only needs an
  // already-installed binary (`npx tsx scripts/x.mts`) just works, while one that
  // must fetch is blocked by the sandbox and escalates to an unsandboxed retry
  // prompt. Without an OS sandbox they still prompt like any external command, so no
  // unpinned code is ever fetched unprompted. (#500, option 1)
  {
    re: /\bnpx\b|\bpnpm\s+dlx\b|\byarn\s+dlx\b|\bbunx\b|\buvx\b|\bpipx\s+run\b|\bpipx\s+install\b/i,
    reason: 'ephemeral package runner (npx/dlx/bunx/uvx/pipx — may fetch & run unpinned code)',
    ambiguous: true,
  },
  { re: /\bcorepack\b/i, reason: 'corepack (downloads package-manager binaries)' },
  {
    re: /\bpip3?\s+install\b|\buv\s+pip\s+install\b|\buv\s+add\b/i,
    reason: 'pip install (may fetch from network)',
  },
  { re: /\bcargo\s+install\b/i, reason: 'cargo install (may fetch from network)' },
  { re: /\bgo\s+(install|get)\b/i, reason: 'go install/get (may fetch + run code from network)' },
  { re: /\bgem\s+install\b/i, reason: 'gem install (may fetch from network)' },
  { re: /\bbrew\s+(install|update|upgrade)\b/i, reason: 'Homebrew install/update' },
  {
    re: /\b(apt|apt-get|dnf|yum|pacman)\s+(install|update|upgrade)\b/i,
    reason: 'system package manager',
  },
  { re: /\bssh\b|\bscp\b|\brsync\b/i, reason: 'remote shell/copy (ssh/scp/rsync)' },
  { re: /\bsocat\b|\blftp\b|\bftp\b/i, reason: 'network utility (socat/ftp/lftp)' },
  // Bash's magic `/dev/tcp/<host>/<port>` and `/dev/udp/...` pseudo-devices open a
  // raw socket via a redirect (`cat </dev/tcp/evil/443`, `exec 3<>/dev/tcp/...`),
  // with no network-tool name for the matchers above to catch. The outside-path
  // scanner deliberately skips `/dev/`, so it must be flagged here. (#581)
  { re: /\/dev\/(?:tcp|udp)\//i, reason: 'raw network socket via /dev/tcp|/dev/udp redirect' },
  // Allow interspersed global options (`git -c protocol.ext.allow=always clone …`,
  // which is a classic clone-time RCE vector) and cover archive, which also reaches
  // the network. `-c` takes a `key=val` argument that isn't flag-shaped, so it gets
  // its own alternative. `fetch` and read-only `submodule` are deliberately absent
  // here — see the dedicated matchers below.
  {
    re: /\bgit\s+(?:-c\s+\S+\s+|--?\S+\s+)*(push|pull|clone|remote|archive)\b/i,
    reason: 'git network operation',
  },
  // `git submodule` is mixed: `update`/`add` fetch from the network and check out +
  // run hooks (a clone-style RCE surface), and `foreach` runs an arbitrary command,
  // so those stay a hard external prompt. Bare `git submodule` and `submodule status`
  // / `summary` are purely local reads (recorded SHAs + working-tree state, like
  // `git status`), so the negative lookahead lets them fall through to `sandbox`. The
  // match fails safe: any subcommand that isn't an explicit read verb stays external.
  // (#500)
  {
    re: /\bgit\s+(?:-c\s+\S+\s+|--?\S+\s+)*submodule\s+(?!status\b|summary\b)\S/i,
    reason: 'git submodule network/checkout operation',
  },
  // `git fetch` only reads refs/objects from the remote — it doesn't modify the
  // remote or run the checkout/merge hooks that `clone`/`submodule update`/`pull` can.
  // Treat it as a network read (like the ephemeral runners above): auto-run *inside*
  // an OS sandbox (a blocked network escalates to an unsandboxed retry) and prompt
  // without one, rather than a hard upfront prompt on every fetch. (#500)
  {
    re: /\bgit\s+(?:-c\s+\S+\s+|--?\S+\s+)*fetch\b/i,
    reason: 'git network read (fetch)',
    ambiguous: true,
  },
  { re: /\bdocker\s+(pull|push|run)\b/i, reason: 'docker network/container operation' },
  { re: /\bkubectl\b|\bhelm\s+install\b/i, reason: 'kubernetes remote operation' },
  {
    re: /\b(aws|gcloud|az)\s+/i,
    reason: 'cloud CLI (may reach external services)',
    ambiguous: true,
  },
  // GitHub CLI. Read-only subcommands (`gh pr view`, `gh issue list`, `gh run status`,
  // …) are carved out by the negative lookahead below: they only *read* from GitHub,
  // so they fall through to a `sandbox` verdict (classifier/seatbelt-gated like any
  // local command) instead of prompting outright where there's no OS sandbox to
  // auto-run inside. Kept deliberately narrow — `gh api` (can POST/DELETE) and every
  // write subcommand (`create`, `merge`, `close`, …) still match here and stay
  // ambiguous. (#500)
  {
    re: new RegExp(`${CMD_POS}gh\\b(?!\\s+(?:pr|issue|run)\\s+(?:list|view|status)\\b)`, 'i'),
    reason: 'GitHub CLI (may reach GitHub)',
    ambiguous: true,
  },
  // `open` / `open -a` (macOS) and `xdg-open` (Linux) hand a file or URL to the OS
  // handler, which launches a *host application in a new process outside* the
  // seatbelt. Unlike most matchers this escapes even when the sandbox is active, so
  // it is hard-external (always prompt), not ambiguous. (#581)
  {
    re: new RegExp(`${CMD_POS}open\\b`, 'i'),
    reason: 'launches a host app/file outside the sandbox (open)',
  },
  { re: /\bxdg-open\b/i, reason: 'launches a host app/file outside the sandbox (xdg-open)' },
  {
    // Direct execution of a workspace-relative file starting with `./` or `../`.
    // Relative paths with a slash but no leading dot (`bin/tool`) are caught by the
    // token layer, which keys off argv[0]. (#581)
    re: new RegExp(`${CMD_POS}\\.\\.?/\\S+`),
    reason: REASON_LOCAL_EXECUTABLE,
  },
  {
    re: new RegExp(`${CMD_POS}nc\\b|\\bnetcat\\b|\\btelnet\\b`, 'i'),
    reason: 'raw network utility',
    ambiguous: true,
  },
  {
    // Inline code passed straight to an interpreter (-c / -e / --eval). The body is
    // opaque to this classifier, so it must always prompt.
    re: /\b(?:python3?|node|deno|bun|ruby|perl)\b[^\n|;&]*\s(?:-c|-e|--eval)\b/i,
    reason: 'inline script (interpreter -c/-e/--eval)',
  },
  {
    // An interpreter executing a local script file (`node ./x.js`, `bash deploy.sh`).
    // The agent can write the script first, so its contents are invisible here — and
    // to the file-blind safety classifier — which is exactly why it must not auto-run.
    re: /\b(?:python3?|node|deno|bun|ruby|perl|bash|sh|zsh)\s+(?:-\S+\s+)*[^\s|;&]*\.(?:js|cjs|mjs|ts|py|rb|pl|sh|bash|zsh)\b/i,
    reason: 'runs a local script via an interpreter (contents opaque to analysis)',
  },
  {
    // Heredoc fed to a real interpreter (`python3 <<EOF … EOF`) — inline code with
    // no `-c`. `cat <<EOF > file` is deliberately excluded (that just writes text).
    re: /\b(?:python3?|node|deno|bun|ruby|perl)\b[^\n]*<<-?/i,
    reason: 'heredoc script fed to an interpreter',
  },
  { re: /\beval\b|\bexec\b|\bbase64\b/i, reason: 'dynamic execution / encoding' },
  { re: /\bpkill\b|\bkillall\b|\bkill\s+-9\b/i, reason: 'process kill (system-wide)' },
  { re: /\bsudo\b|\bsu\s+-/i, reason: 'privilege escalation' },
  {
    re: /\brm\s+-\S*[rf]\S*\s+(?:\/\s*$|~\/|\$HOME)/i,
    reason: 'destructive path outside workspace',
  },
  { re: /\brm\s+-rf\s+\/\b|\brm\s+-rf\s+~\b/i, reason: 'destructive path outside workspace' },
  { re: /\bchmod\s+[0-7]*7/i, reason: 'broad permission change' },
  { re: /\bmkfs\b|\bfdisk\b|\bdd\s+if=/i, reason: 'disk/system modification' },
]

// Paths that indicate access outside the workspace.
const OUTSIDE_PATH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(?:^|[\s|])~(?:\/|\b)/, reason: 'home directory path (~/)' },
  { re: /\$HOME\b/, reason: '$HOME reference' },
  { re: /(?:^|[\s|])\/etc\//, reason: 'system path (/etc/)' },
  { re: /(?:^|[\s|])\/usr\//, reason: 'system path (/usr/)' },
  { re: /(?:^|[\s|])\/var\//, reason: 'system path (/var/)' },
  { re: /(?:^|[\s|])\/tmp\//, reason: 'global temp path (/tmp/)' },
  { re: /\.\.\//, reason: 'parent directory traversal (../)' },
]

/**
 * Undo the cheap obfuscations the shell collapses away but that defeat the
 * word-boundary patterns below: backslash escapes (`c\url` → `curl`) and shell
 * quoting (`c""url`, `'r''m'`, `r"m"` → `curl`/`rm`). Stripping every quote can
 * merge string literals into adjacent tokens, but over-matching here only ever
 * causes an extra approval prompt — never a silent auto-run — so we normalise
 * aggressively in the safe direction.
 */
export function normalizeShellCommandForAnalysis(command: string): string {
  return command.replace(/\\(?=[a-zA-Z0-9])/g, '').replace(/['"]/g, '')
}

// Signals that a package command points at a non-default registry or carries
// inline credentials — a classic vector for pulling from an attacker-controlled
// mirror or leaking tokens (#174).
const REGISTRY_REDIRECT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /--registry(=|\s)/i,
    reason: 'custom package registry (--registry) — verify it is trusted',
  },
  { re: /\b_authToken\b|\bnpm_config_registry\b/i, reason: 'inline registry credentials/override' },
  {
    re: /\bpip\b[^\n|;&]*--(index-url|extra-index-url)(=|\s)/i,
    reason: 'custom pip index URL — verify it is trusted',
  },
  {
    re: /\bcargo\b[^\n|;&]*--registry(=|\s)/i,
    reason: 'custom cargo registry — verify it is trusted',
  },
]

// Interpreters whose *first operand* is a script/inline body opaque to this
// classifier. Keyed off `argv[0]` (the resolved executable, path-stripped) after
// shell-quote lexing, so quoting/indirection can't hide the interpreter name.
const TOKEN_INTERPRETERS = new Set([
  'python',
  'python2',
  'python3',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'bash',
  'sh',
  'zsh',
])
// Recognised script-file extensions — kept byte-for-byte in sync with the
// interpreter-runs-file regex in EXTERNAL_PATTERNS so tokenization never diverges
// from (only reinforces) the regex baseline.
const TOKEN_SCRIPT_EXT = /\.(?:js|cjs|mjs|ts|py|rb|pl|sh|bash|zsh)$/i
// Inline-code flags: the body is opaque, so an interpreter carrying one must prompt.
const TOKEN_INLINE_FLAGS = new Set(['-c', '-e', '--eval'])
// Exact reason strings shared with the regex entries above, so token-derived and
// regex-derived hits dedupe against each other.
const REASON_INTERPRETER_FILE =
  'runs a local script via an interpreter (contents opaque to analysis)'
const REASON_INTERPRETER_INLINE = 'inline script (interpreter -c/-e/--eval)'
const REASON_BUILD_DRIVER =
  'build driver may require host caches or system build services (xcodebuild/gradle/swift/cargo)'

/**
 * A build may look workspace-contained in its argv yet need host-owned caches
 * (`~/Library`, `~/.gradle`, `~/.cargo`) or an XPC build service. Mark just
 * those build operations ambiguous: macOS still tries them inside seatbelt by
 * default, while an agent that knows the toolchain will be blocked can request
 * the existing explicit unsandboxed approval with `expects_sandbox_block`.
 */
function isHostDependentBuildDriver(exe: string, args: string[]): boolean {
  if (exe === 'xcodebuild' || exe === 'gradle') return true
  if (exe === 'swift') return ['build', 'test', 'run', 'package'].includes(args[0] ?? '')
  if (exe === 'cargo') {
    return ['build', 'check', 'test', 'run', 'bench', 'doc'].includes(args[0] ?? '')
  }
  return false
}

/**
 * Structured, token-based detectors that complement — never replace — the regex
 * pass. Running shell-quote's lexer lets classification key off `argv[0]` (the
 * actual executable) and structured arguments instead of substring matching, which
 * closes quoting/indirection gaps the fragile interpreter-runs-file regex misses
 * (e.g. `node -r ./preload build.js`, where the non-flag `-r` argument defeats the
 * regex's flag-skip, or `deno run server.ts`, where the subcommand sits between the
 * interpreter and the file).
 *
 * It is strictly ADDITIVE: it only ever appends reasons or promotes to `hasHard`,
 * and callers union its result with the regex baseline. It can never remove a reason
 * or downgrade a verdict, so it cannot make the permission gate more permissive than
 * the regex path alone. Anything shell-quote can't lex into a plain argv — operators,
 * command/process substitution, globs, comments, or a parse failure — is left
 * entirely to the regex fallback: such tokens merely delimit the simple-command
 * segments we inspect and are otherwise ignored here.
 */
function tokenBasedExternalReasons(command: string): { reasons: string[]; hasHard: boolean } {
  const reasons: string[] = []
  let hasHard = false

  let tokens: ReturnType<typeof parseShellCommand>
  try {
    tokens = parseShellCommand(command)
  } catch {
    // Un-lexable input → defer entirely to the regex fallback.
    return { reasons, hasHard }
  }

  const addReason = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }

  // Split the token stream into simple-command segments at every non-string token
  // (operator / substitution / glob / comment object). Each segment is a plain argv
  // the shell would execute directly; structural tokens between them stay the regex
  // path's responsibility.
  let segment: string[] = []
  const inspect = (): void => {
    const exe0 = segment[0]
    if (exe0 === undefined) return
    // argv[0] is a workspace-relative path (`./x`, `../x`, `bin/tool`) — the shell
    // executes the file directly from the cwd. Absolute paths are left to the
    // outside-path scanner; a bare name (no slash) is a PATH lookup, not a local
    // file. This catches the extensionless executables the regex extension list
    // can't. (#581)
    if (!exe0.startsWith('/') && exe0.includes('/')) {
      addReason(REASON_LOCAL_EXECUTABLE)
      hasHard = true
    }
    const exe = basename(exe0).toLowerCase()
    const args = segment.slice(1)
    if (isHostDependentBuildDriver(exe, args)) {
      addReason(REASON_BUILD_DRIVER)
    }
    if (TOKEN_INTERPRETERS.has(exe)) {
      if (args.some((a) => TOKEN_INLINE_FLAGS.has(a))) {
        addReason(REASON_INTERPRETER_INLINE)
        hasHard = true
      }
      if (args.some((a) => TOKEN_SCRIPT_EXT.test(a))) {
        addReason(REASON_INTERPRETER_FILE)
        hasHard = true
      }
    }
    segment = []
  }
  for (const token of tokens) {
    if (typeof token === 'string') segment.push(token)
    else inspect()
  }
  inspect()

  return { reasons, hasHard }
}

// `hasHard` is true when at least one matched signal is a definite escape
// (network download, install, git push, command substitution, …) rather than a
// fuzzy `ambiguous` matcher. It decides whether the verdict is `external`
// (prompt + run outside) or merely `ambiguous` (auto-run inside the sandbox).
function collectExternalReasons(command: string): { reasons: string[]; hasHard: boolean } {
  const reasons: string[] = []
  let hasHard = false
  const variants = [command, normalizeShellCommandForAnalysis(command)]
  for (const text of variants) {
    for (const { re, reason, ambiguous } of EXTERNAL_PATTERNS) {
      if (re.test(text) && !reasons.includes(reason)) {
        reasons.push(reason)
        if (!ambiguous) hasHard = true
      }
    }
    for (const { re, reason } of REGISTRY_REDIRECT_PATTERNS) {
      if (re.test(text) && !reasons.includes(reason)) {
        reasons.push(reason)
        hasHard = true
      }
    }
  }
  if (/\$\(|`/.test(command)) {
    reasons.push('command substitution (may hide network or outside-path tools)')
    hasHard = true
  }
  // Additive token pass: reinforces the fragile interpreter checks above without
  // ever loosening the result (union of reasons; hasHard only promoted, never cleared).
  const tokenHits = tokenBasedExternalReasons(command)
  for (const reason of tokenHits.reasons) {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  if (tokenHits.hasHard) hasHard = true
  return { reasons, hasHard }
}

function referencesOutsideWorkspace(command: string, workspaceRoot: string | null): string | null {
  for (const { re, reason } of OUTSIDE_PATH_PATTERNS) {
    if (re.test(command)) return reason
  }

  if (!workspaceRoot) return null

  const root = resolve(workspaceRoot)
  const home = homedir()
  // Absolute paths in the command that aren't under the workspace root.
  const absPaths = command.match(/(?:^|[\s'"=])(\/[^\s'"|;&]+)/g) ?? []
  for (const raw of absPaths) {
    const p = raw.trim().replace(/^[\s'"=]+/, '')
    if (p.startsWith('/dev/') || p.startsWith('/proc/')) continue
    const resolved = resolve(p)
    if (resolved.startsWith(root + '/') || resolved === root) continue
    if (resolved.startsWith(home + '/') && !resolved.startsWith(root + '/')) {
      return `absolute path outside workspace: ${p}`
    }
    if (resolved !== root && !resolved.startsWith(root + '/')) {
      return `absolute path outside workspace: ${p}`
    }
  }

  return null
}

/**
 * Commands that are destructive or resource-exhausting even when fully contained
 * inside the workspace sandbox. macOS seatbelt blocks network + out-of-workspace
 * FS, but does nothing about `rm -rf` inside the repo, fork bombs, or piping a
 * downloaded script straight into a shell. These must still prompt even when the
 * OS sandbox is active (see issue #103: sandboxed auto-allow was a blanket bypass
 * of the classifier).
 */
const DANGEROUS_IN_SANDBOX_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\brm\s+-\S*[rf]/i, reason: 'recursive/forced delete (rm -rf)' },
  { re: /\bgit\s+clean\s+-\S*[dfx]/i, reason: 'git clean removes untracked files' },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard discards changes' },
  { re: /\bgit\s+checkout\s+--\s+\./i, reason: 'git checkout discards local changes' },
  { re: />\s*\/dev\/(?:sda|disk|null\s+2>&1\s*&\s*$)/i, reason: 'raw device write' },
  { re: /\bfind\b[^\n|;&]*\s-delete\b/i, reason: 'find -delete bulk removal' },
  { re: /\btruncate\b|\bshred\b/i, reason: 'file truncation/shredding' },
  // Pipe-to-shell: `curl … | sh`, `wget … | bash`, etc. (the curl is also caught
  // as external, but this fires even for in-workspace scripts piped to a shell).
  {
    re: /\|\s*(?:sh|bash|zsh|python3?|node|ruby|perl)\b/i,
    reason: 'piping output into an interpreter',
  },
  // Classic shell fork bomb and obvious busy-loop fork patterns.
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: 'fork bomb' },
  { re: /\bwhile\s+(?:true|:)\s*;?\s*do\b/i, reason: 'unbounded loop (CPU exhaustion)' },
  { re: /\byes\b\s*\|/i, reason: 'unbounded `yes` output' },
]

/** Destructive/resource-exhausting patterns that warrant a prompt even when sandboxed. */
export function dangerousInSandboxReasons(command: string): string[] {
  const reasons: string[] = []
  const variants = [command, normalizeShellCommandForAnalysis(command)]
  for (const text of variants) {
    for (const { re, reason } of DANGEROUS_IN_SANDBOX_PATTERNS) {
      if (re.test(text) && !reasons.includes(reason)) reasons.push(reason)
    }
  }
  return reasons
}

export function analyzeShellCommand(
  command: string,
  workspaceRoot: string | null,
): ShellScopeAnalysis {
  const trimmed = command.trim()
  if (!trimmed) {
    return { verdict: 'sandbox', reasons: ['empty command'] }
  }

  const { reasons, hasHard } = collectExternalReasons(trimmed)

  // Outside-workspace filesystem access is always a hard escape: we want such
  // commands to prompt and run outside the sandbox, not attempt-then-retry.
  const outsidePath = referencesOutsideWorkspace(trimmed, workspaceRoot)
  if (outsidePath) reasons.push(outsidePath)

  if (reasons.length === 0) {
    // Local-only commands with no escape signals are sandbox-contained.
    return { verdict: 'sandbox', reasons: ['no network or outside-path signals detected'] }
  }

  // Only fuzzy "may reach" matchers fired → ambiguous: safe to auto-run inside an
  // OS sandbox (it contains any real escape) but still prompt without one.
  return { verdict: hasHard || outsidePath !== null ? 'external' : 'ambiguous', reasons }
}
