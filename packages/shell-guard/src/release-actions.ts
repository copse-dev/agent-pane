import { commandName, shellInputRedirects } from './shell-argv.ts'
import { secretFileName, secretFilesIn } from './secrets.ts'

/**
 * Release work that a person must see: loading a secret file into the shell,
 * signing with a release key, running a release or deploy entry point, publishing
 * a tag, and overriding git's credential helper for one command.
 *
 * A replay of one developer's real history (benchmarks/risk-classifier) found the
 * Guarded YOLO harm gate allowing each of these outside the sandbox: an agent
 * sourced `.env.release`, piped the Sparkle private key into `sign_update`, ran
 * `make ship-release`, force-moved and pushed a release tag, and pushed a site's
 * appcast with its own credential helper. None of them names a program the gate
 * already knew to be a publisher, so each family gets its own reason here. Every
 * rule only adds a prompt.
 */

/** Words a release, publish or deploy entry point starts with: `ship-release`, `deploy:prod`. */
const RELEASE_TARGET = /^(?:ship|release|publish|deploy|notari[sz]e|upload)(?:$|[-_:.])/i

/** Task runners whose operands name targets: `make ship-release VERSION=1.7.0`. */
const TASK_RUNNERS = new Set(['make', 'gmake', 'just', 'task', 'rake', 'mise'])

/** Task-runner options that take the next word as their value, not a target. */
const TASK_RUNNER_VALUE_OPTIONS = new Set([
  '-C',
  '-f',
  '--file',
  '--directory',
  '-I',
  '-j',
  '-o',
  '-W',
])

/** Package managers whose `run <script>` (or bare `<script>`) runs a package script. */
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Options that turn a task run into a listing or a rehearsal. */
const REHEARSAL = /^(?:--dry-run|--just-print|--recon|-n|--list|-l|--help|-h)$/

/** Programs whose job is to sign a release artifact with a private key. */
const RELEASE_SIGNERS = new Set(['sign_update', 'generate_keys', 'minisign', 'signify'])

/** Git global options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
])

/**
 * A ref git reads as a tag, or a version-shaped name (`v1`, `v1.7.0`, `1.2`, `v2.0.0-rc.1`):
 * pushing one usually publishes a release. `tags/x` is git's shorthand for `refs/tags/x`.
 */
const VERSION_REF =
  /^(?:refs\/tags\/.+|tags\/.+|v\d+(?:\.\d+){0,2}(?:[-+.][\w.]+)?|\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)$/

/** Whether `arg` is an option git would expand to `long`: git accepts any unique prefix. */
function abbreviates(arg: string, long: string, shortest: number): boolean {
  return arg.length >= shortest && long.startsWith(arg)
}

function onlyHelp(argv: readonly string[]): boolean {
  return argv.length > 1 && argv.slice(1).every((arg) => /^(?:--help|-h|--version)$/.test(arg))
}

/** The first non-option operands after a task runner, skipping option values and `VAR=value`. */
function taskTargets(argv: readonly string[]): string[] {
  const targets: string[] = []
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (TASK_RUNNER_VALUE_OPTIONS.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-') || /^[A-Za-z_][\w]*=/.test(arg)) continue
    targets.push(arg)
  }
  return targets
}

function releaseEntryPoint(head: string, argv: readonly string[]): string | null {
  if (argv.slice(1).some((arg) => REHEARSAL.test(arg))) return null
  if (TASK_RUNNERS.has(head)) {
    const target = taskTargets(argv).find((word) => RELEASE_TARGET.test(word))
    return target ? `runs a release or deploy entry point (${head} ${target})` : null
  }
  if (SCRIPT_RUNNERS.has(head)) {
    const words = argv.slice(1).filter((arg) => !arg.startsWith('-'))
    // `pnpm run deploy`, `npm run release:mac`, `yarn ship`. `pnpm deploy` is pnpm's own
    // command, which copies a package into a directory, so only the `run` form counts there.
    const script =
      words[0] === 'run' || words[0] === 'run-script'
        ? words[1]
        : head === 'pnpm'
          ? undefined
          : words[0]
    // `npm publish` is a registry publish, reported by remote-change.ts.
    if (!script || /^(?:publish|unpublish)$/.test(script)) return null
    return RELEASE_TARGET.test(script)
      ? `runs a release or deploy entry point (${head} run ${script})`
      : null
  }
  return null
}

function signingReason(head: string, argv: readonly string[]): string | null {
  if (RELEASE_SIGNERS.has(head)) {
    return onlyHelp(argv) ? null : `signs a release with a private key (${head})`
  }
  if (head === 'codesign') {
    // `-s` may sit in a cluster (`-fs ID`); its value is the identity, and `-` is ad-hoc
    // signing, which uses no key.
    const index = argv.findIndex((arg) => arg === '--sign' || /^-[a-zA-Z]*s$/.test(arg))
    if (index !== -1 && argv[index + 1] !== '-') {
      return 'signs code with a keychain identity (codesign --sign)'
    }
    return null
  }
  if (
    (head === 'gpg' || head === 'gpg2') &&
    argv.some(
      (arg) =>
        /^(?:--sign|--detach-sign|--clearsign|--clear-sign)$/.test(arg) ||
        /^-[a-zA-Z]*[sb][a-zA-Z]*$/.test(arg),
    )
  ) {
    return `signs with a private key (${head})`
  }
  if (head === 'xcrun' && argv[1] === 'notarytool' && argv[2] === 'submit') {
    return 'submits a build to Apple notarization (xcrun notarytool submit)'
  }
  return null
}

/** Git's subcommand and its operands, with global options and their values removed. */
export function gitWords(argv: readonly string[]): { config: string[]; words: string[] } {
  const config: string[] = []
  let i = 1
  for (; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (GIT_VALUE_OPTIONS.has(arg) || arg === '--config-env') {
      if (arg === '-c' || arg === '--config-env') config.push(argv[i + 1] ?? '')
      i += 1
      continue
    }
    if (arg.startsWith('-')) {
      if (arg.startsWith('-c') && arg.length > 2) config.push(arg.slice(2))
      if (arg.startsWith('--config-env=')) config.push(arg.slice('--config-env='.length))
      continue
    }
    break
  }
  return { config, words: argv.slice(i) }
}

/** Config keys that make git run a program, or read another file that could. */
const PROGRAM_CONFIG_KEY =
  /^(?:credential\.|core\.(?:sshCommand|askPass|fsmonitor|hooksPath|pager|editor)\b|include\.|includeIf\.)/i

/** Push options that rewrite or delete refs on the remote (git accepts any unique prefix). */
function rewritesRemoteRefs(arg: string): boolean {
  return (
    abbreviates(arg, '--mirror', 4) ||
    abbreviates(arg, '--prune', 5) ||
    abbreviates(arg, '--delete', 4) ||
    arg === '-d'
  )
}

function gitReleaseReasons(argv: readonly string[]): string[] {
  const { config, words } = gitWords(argv)
  const reasons: string[] = []
  if (config.some((setting) => PROGRAM_CONFIG_KEY.test(setting))) {
    reasons.push("overrides git's credentials or SSH command for this command")
  }
  const [subcommand = '', ...rest] = words
  if (subcommand === 'push') {
    const tags = rest.some(
      (arg) => abbreviates(arg, '--tags', 4) || abbreviates(arg, '--follow-tags', 5),
    )
    const operands = rest.filter((arg) => !arg.startsWith('-')).slice(1) // after the remote
    // `git push origin tag v1` names a tag whatever it is called.
    const keyword = operands.indexOf('tag')
    const versionRef =
      keyword !== -1 && operands[keyword + 1] !== undefined
        ? `tag ${operands[keyword + 1] ?? ''}`
        : operands
            .map((arg) => arg.replace(/^\+/, '').split(':').pop() ?? '')
            .find((ref) => VERSION_REF.test(ref))
    if (tags || versionRef)
      reasons.push(`publishes a release tag (git push ${versionRef ?? '--tags'})`)
    if (rest.some(rewritesRemoteRefs) || operands.some((arg) => arg.startsWith('+'))) {
      reasons.push('rewrites or deletes refs on the remote (git push)')
    }
  }
  if (subcommand === 'tag' && rest.some((arg) => arg === '-f' || arg === '--force')) {
    reasons.push('moves an existing tag (git tag --force)')
  }
  // A lasting `git config core.sshCommand …` makes every later git call run it, as a
  // credential helper does (which `tokenPrinterReason` already asks about).
  if (subcommand === 'config') {
    const reads = rest.some((arg) =>
      /^(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|--show-origin|--name-only)$/.test(arg),
    )
    const key = rest.find((arg) => !arg.startsWith('-'))
    if (
      !reads &&
      key !== undefined &&
      PROGRAM_CONFIG_KEY.test(key) &&
      !/^credential\./i.test(key)
    ) {
      reasons.push(`sets a git config key that runs a program (${key})`)
    }
  }
  return reasons
}

/** Reserved words that can precede a command in the same segment. */
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  '!',
  '{',
  '(',
])

/**
 * Programs that copy a file somewhere else: a secret file copied is a secret exposed there. For
 * these the last operand is the destination, so `cp .env.example .env` (making one) is fine.
 */
const COPIERS = new Set(['cp', 'mv', 'ditto', 'rsync', 'scp', 'install', 'ln'])
/** Archivers read every operand they are given. */
const ARCHIVERS = new Set(['tar', 'zip', '7z'])

/** Variables that hand git or ssh a program to fetch credentials or open the connection. */
const CREDENTIAL_PROGRAM_VARIABLES =
  /(?:^|[\s;&|(])(?:GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM)=/

/**
 * Command-line reasons no single argv shows: a secret file fed in through `<`
 * (`base64 < .env`, `while read l; do export "$l"; done < .env`), and a credential
 * program chosen through the environment (`GIT_ASKPASS=/tmp/x git push`), which
 * `unwrapWrappers` strips as an assignment before any argv rule sees it.
 */
export function releaseCommandReasons(command: string): string[] {
  const reasons: string[] = []
  const fed = shellInputRedirects(command)
    .map((target) => secretFileName(target))
    .filter((name) => name !== null)
  if (fed.length > 0)
    reasons.push(`reads a secret file through a redirect (${[...new Set(fed)].join(', ')})`)
  if (CREDENTIAL_PROGRAM_VARIABLES.test(command)) {
    reasons.push('chooses the program git or ssh uses for credentials')
  }
  return reasons
}

/** Why one unwrapped argv is release work a person must see; empty when it is not. */
export function releaseActionReasons(segment: readonly string[]): string[] {
  // `if . ./.env; then` reaches here as one segment headed by the keyword.
  let start = 0
  while (start < segment.length - 1 && SHELL_KEYWORDS.has(segment[start] ?? '')) start += 1
  const argv = segment.slice(start)
  const head = commandName(argv[0])
  const reasons: string[] = []
  if (head === '.' || head === 'source') {
    const names = secretFilesIn(argv)
    if (names.length > 0) reasons.push(`loads a secret file into the shell (${names.join(', ')})`)
  }
  if (COPIERS.has(head) || ARCHIVERS.has(head)) {
    // `cp -t DIR src…` names the destination by option, so every operand is a source.
    const target = argv.findIndex((arg) => arg === '-t' || arg === '--target-directory')
    const operands = argv.filter(
      (arg, index) => index > 0 && !arg.startsWith('-') && (target === -1 || index !== target + 1),
    )
    const byOption = target !== -1 || argv.some((arg) => arg.startsWith('--target-directory='))
    const sources = COPIERS.has(head) && !byOption ? operands.slice(0, -1) : operands
    const names = secretFilesIn(['', ...sources])
    if (names.length > 0) reasons.push(`copies a secret file (${names.join(', ')})`)
  }
  if (
    head === 'ssh-add' &&
    (argv.length === 1 || !argv.slice(1).every((arg) => /^-[lL]+$/.test(arg)))
  ) {
    reasons.push("changes the SSH agent's identities (ssh-add)")
  }
  const entryPoint = releaseEntryPoint(head, argv)
  if (entryPoint) reasons.push(entryPoint)
  const signing = signingReason(head, argv)
  if (signing) reasons.push(signing)
  if (head === 'git') reasons.push(...gitReleaseReasons(argv))
  return reasons
}
