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

/** A version-shaped ref (`v1.7.0`, `1.2`, `v2.0.0-rc.1`): pushing one usually publishes a release. */
const VERSION_REF = /^(?:refs\/tags\/.+|v?\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?)$/

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
  if (head === 'codesign' && argv.some((arg) => arg === '-s' || arg === '--sign')) {
    return 'signs code with a keychain identity (codesign --sign)'
  }
  if (
    (head === 'gpg' || head === 'gpg2') &&
    argv.some((arg) => /^(?:-s|--sign|-b|--detach-sign|--clearsign|--clear-sign)$/.test(arg))
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
    if (GIT_VALUE_OPTIONS.has(arg)) {
      if (arg === '-c') config.push(argv[i + 1] ?? '')
      i += 1
      continue
    }
    if (arg.startsWith('-')) {
      if (arg.startsWith('-c') && arg.length > 2) config.push(arg.slice(2))
      continue
    }
    break
  }
  return { config, words: argv.slice(i) }
}

function gitReleaseReasons(argv: readonly string[]): string[] {
  const { config, words } = gitWords(argv)
  const reasons: string[] = []
  if (config.some((setting) => /^(?:credential\.|core\.(?:sshCommand|askPass)=)/i.test(setting))) {
    reasons.push("overrides git's credentials or SSH command for this command")
  }
  const [subcommand = '', ...rest] = words
  if (subcommand === 'push') {
    const tags = rest.some((arg) => arg === '--tags' || arg === '--follow-tags')
    const versionRef = rest
      .filter((arg) => !arg.startsWith('-'))
      .slice(1) // the first operand is the remote
      .map((arg) => arg.replace(/^\+/, '').split(':').pop() ?? '')
      .find((ref) => VERSION_REF.test(ref))
    if (tags || versionRef)
      reasons.push(`publishes a release tag (git push ${versionRef ?? '--tags'})`)
  }
  if (subcommand === 'tag' && rest.some((arg) => arg === '-f' || arg === '--force')) {
    reasons.push('moves an existing tag (git tag --force)')
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
  /(?:^|[\s;&|(])(?:GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND)=/

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
    const operands = argv.slice(1).filter((arg) => !arg.startsWith('-'))
    const sources = COPIERS.has(head) ? operands.slice(0, -1) : operands
    const names = secretFilesIn(['', ...sources])
    if (names.length > 0) reasons.push(`copies a secret file (${names.join(', ')})`)
  }
  if (head === 'ssh-add' && !argv.slice(1).every((arg) => /^-[lL]+$/.test(arg))) {
    reasons.push("changes the SSH agent's identities (ssh-add)")
  }
  const entryPoint = releaseEntryPoint(head, argv)
  if (entryPoint) reasons.push(entryPoint)
  const signing = signingReason(head, argv)
  if (signing) reasons.push(signing)
  if (head === 'git') reasons.push(...gitReleaseReasons(argv))
  return reasons
}
