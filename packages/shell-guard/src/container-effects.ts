/**
 * Effect classification for a shell command that runs inside a disposable
 * container (`docs/plans/thread-in-container.md`).
 *
 * A container changes what a prompt is *for*. Anything whose blast radius dies
 * with the guest — deleting the checkout, installing a toolchain, running an
 * unrecognised binary — needs no human, because `docker rm` undoes it. Two
 * classes still do:
 *
 * - **Outward effects** leave the guest by design: `git push`, a GitHub write, a
 *   package publish, an HTTP write to some service. The container does nothing
 *   for these, so an unattended run *defers* them to the review queue.
 * - **Host escapes** should be impossible by construction (no Docker socket, no
 *   host mounts). They are hard-denied so a hit is visible: it means the image
 *   or the run policy is wrong, not that the agent found a loophole.
 *
 * Pure and host-free like the rest of `@copse/shell-guard`. Like every
 * classifier here it routes and explains; it grants nothing on its own — the
 * gate that consumes it still requires an explicitly armed unattended run on a
 * runtime that attests to container containment.
 */
import { commandName, shellSegments, unwrapWrappers } from './shell-argv.ts'
import { classifyGhSegment } from './gh-argv.ts'
import type { ShellHarmDecision } from './shell-harm.ts'

export type ContainedEffectAction = 'allow' | 'defer' | 'deny'

export interface ContainedEffectDecision {
  action: ContainedEffectAction
  reasons: string[]
}

const HOST_ESCAPE_COMMANDS: ReadonlySet<string> = new Set([
  'docker',
  'podman',
  'nerdctl',
  'ctr',
  'crictl',
  'nsenter',
  'chroot',
  'pivot_root',
  'mount',
  'umount',
  'setns',
])

const HOST_ESCAPE_PATH_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /docker\.sock\b/i, reason: 'reaches the Docker daemon socket' },
  { re: /containerd\.sock\b/i, reason: 'reaches the containerd socket' },
  { re: /\/proc\/1\/(?:root|ns|cwd)\b/, reason: 'reaches the init process namespace' },
  { re: /\/proc\/sys(?:kernel|\/)/, reason: 'writes kernel parameters' },
  { re: /\/dev\/(?:mem|kmem|sd[a-z]|nvme|disk)\b/, reason: 'touches a raw host device' },
]

/** Package-manager verbs that publish to a registry. */
const PUBLISH_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'access']),
  pnpm: new Set(['publish', 'unpublish', 'deprecate']),
  yarn: new Set(['publish', 'npm']),
  cargo: new Set(['publish', 'yank', 'owner']),
  gem: new Set(['push', 'yank', 'owner']),
  twine: new Set(['upload']),
  helm: new Set(['push']),
  flit: new Set(['publish']),
  poetry: new Set(['publish']),
  mvn: new Set(['deploy']),
  gradle: new Set(['publish', 'uploadArchives']),
}

/** CLIs whose invocations reach and may mutate remote infrastructure. */
const REMOTE_MUTATION_CLIS: ReadonlySet<string> = new Set([
  'aws',
  'az',
  'gcloud',
  'kubectl',
  'terraform',
  'pulumi',
  'flyctl',
  'fly',
  'vercel',
  'netlify',
  'heroku',
  'wrangler',
  'serverless',
  'sls',
  'ansible',
  'ansible-playbook',
  'scw',
  'doctl',
  'linode-cli',
  'hcloud',
])

/** Programs whose purpose is to message a human or a service. */
const MESSAGING_COMMANDS: ReadonlySet<string> = new Set([
  'mail',
  'mailx',
  'sendmail',
  'msmtp',
  'slack',
  'twilio',
])

const HTTP_WRITE_METHODS = /^(?:POST|PUT|PATCH|DELETE)$/i

function firstPositional(args: readonly string[]): string | undefined {
  return args.find((token) => !token.startsWith('-'))
}

function gitSubcommand(args: readonly string[]): string | undefined {
  // Skip `-c key=value`, `-C <path>` and any other option, with its value where
  // the option takes one, until the first bare word: that is the subcommand.
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === undefined) continue
    if (token === '-c' || token === '-C' || token === '--git-dir' || token === '--work-tree') {
      index++
      continue
    }
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

function curlWrites(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? ''
    if (token === '-X' || token === '--request') {
      const method = args[index + 1] ?? ''
      if (HTTP_WRITE_METHODS.test(method)) return true
      continue
    }
    if (/^(?:-X|--request=)(POST|PUT|PATCH|DELETE)$/i.test(token)) return true
    if (
      token === '-d' ||
      token === '-F' ||
      token === '-T' ||
      token.startsWith('--data') ||
      token === '--form' ||
      token === '--upload-file' ||
      token === '--json'
    ) {
      return true
    }
  }
  return false
}

function wgetWrites(args: readonly string[]): boolean {
  return args.some(
    (token) =>
      token.startsWith('--post-data') ||
      token.startsWith('--post-file') ||
      token.startsWith('--method=P') ||
      token.startsWith('--method=D') ||
      token.startsWith('--body-'),
  )
}

/**
 * Reasons this command could reach the host that the container is supposed to
 * confine. Empty when none were found.
 */
export function detectHostEscape(command: string): string[] {
  const reasons: string[] = []
  const add = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  for (const { re, reason } of HOST_ESCAPE_PATH_PATTERNS) {
    if (re.test(command)) add(reason)
  }
  for (const segment of shellSegments(command)) {
    const argv = unwrapWrappers(segment)
    const name = commandName(argv[0])
    if (HOST_ESCAPE_COMMANDS.has(name)) add(`${name} is a container or host escape primitive`)
  }
  return reasons
}

/**
 * Reasons this command's effect would leave the container even though the
 * container itself is disposable. Empty when the command's effects are
 * confined to the guest (or to plain network reads, which the egress policy
 * decides on its own).
 */
export function detectOutwardEffect(command: string): string[] {
  const reasons: string[] = []
  const add = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason)
  }
  for (const segment of shellSegments(command)) {
    const argv = unwrapWrappers(segment)
    const name = commandName(argv[0])
    const args = argv.slice(1)
    switch (name) {
      case 'git': {
        const sub = gitSubcommand(args)
        if (sub === 'push') add('git push publishes commits to a remote')
        else if (sub === 'send-email') add('git send-email sends mail')
        else if (sub === 'svn' && args.includes('dcommit'))
          add('git svn dcommit writes to a remote')
        break
      }
      case 'gh': {
        const kind = classifyGhSegment(argv)
        if (kind !== 'read') add('GitHub CLI write or unrecognised shape')
        break
      }
      case 'curl':
        if (curlWrites(args)) add('HTTP write (curl with a mutating method or body)')
        break
      case 'wget':
        if (wgetWrites(args)) add('HTTP write (wget with a request body)')
        break
      default: {
        const verbs = PUBLISH_VERBS[name]
        if (verbs) {
          const verb = firstPositional(args)
          if (verb !== undefined && verbs.has(verb)) add(`${name} ${verb} publishes to a registry`)
          break
        }
        if (REMOTE_MUTATION_CLIS.has(name)) add(`${name} may mutate remote infrastructure`)
        if (MESSAGING_COMMANDS.has(name)) add(`${name} messages a human or an external service`)
      }
    }
  }
  return reasons
}

/**
 * The verdict for a command in an unattended run on a container runtime, given
 * the host-owned harm assessment of the same command.
 *
 * Order matters and is deliberate:
 * 1. a host escape is denied before anything else — it is a policy bug, not a
 *    judgement call;
 * 2. the harm gate's hard denies stay hard (a fork bomb or `rm -rf /` inside the
 *    guest still ends the run, and there is no human to ask);
 * 3. an outward effect is deferred, never allowed, because the container does
 *    not contain it;
 * 4. everything else — including the harm gate's *prompt* verdicts, which are
 *    all in-guest destructive shapes — is allowed as contained.
 */
export function decideContainedShellEffect(
  command: string,
  harm: ShellHarmDecision,
): ContainedEffectDecision {
  const escape = detectHostEscape(command)
  if (escape.length > 0) return { action: 'deny', reasons: escape }
  if (harm.action === 'deny') return { action: 'deny', reasons: harm.reasons }
  const outward = detectOutwardEffect(command)
  if (outward.length > 0) return { action: 'defer', reasons: outward }
  if (harm.action === 'prompt') {
    return {
      action: 'allow',
      reasons: harm.reasons.map((reason) => `${reason} — contained by the container runtime`),
    }
  }
  return { action: 'allow', reasons: ['no outward effect or host escape detected'] }
}
