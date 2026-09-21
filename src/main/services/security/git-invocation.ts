/**
 * Internal Git operations are app plumbing, not permission-gated shell commands.
 * Keep their command vocabulary explicit: an unknown command could be a repo
 * alias or an external git-* executable. Additions need a config-execution audit.
 */
const INTERNAL_GIT_COMMANDS = new Set([
  '--version',
  'add',
  'branch',
  'cat-file',
  'check-ignore',
  'check-ref-format',
  // User-requested commits go through a permission-gated execution profile, so
  // hooks/signing work there. Only automatic commit-tree snapshots belong here.
  'commit-tree',
  'config',
  'diff',
  'fetch',
  'for-each-ref',
  'log',
  'init',
  'ls-files',
  'ls-tree',
  'merge-base',
  'read-tree',
  'remote',
  'push',
  'restore',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'switch',
  'symbolic-ref',
  'update-ref',
  'worktree',
  'write-tree',
])

/**
 * These overrides apply at execution time, including to included/worktree config.
 * Do not replace them with a preflight scan: config can change after inspection.
 * In particular, hooksPath does NOT disable core.fsmonitor (GitSpawn).
 */
const INTERNAL_GIT_CONFIG = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'core.pager=cat',
  'color.ui=false',
  'maintenance.auto=false',
  'gc.auto=0',
  'submodule.recurse=false',
  'commit.gpgSign=false',
  'log.showSignature=false',
  // A configured pretty format containing %G? would verify signatures even
  // with log.showSignature=false. Internal callers choose their own formats.
  'format.pretty=medium',
] as const

export type GitConfigPolicy = 'internal' | 'user-command'

/** Host-created signer bridge, never model-supplied configuration. */
export interface GitSigningBridge {
  program: string
  publicKey: string
}

export function withGitInvocationArgs(
  args: string[],
  policy: GitConfigPolicy = 'internal',
  signing?: GitSigningBridge,
): string[] {
  const identity: string[] = []
  let remaining = args
  // The shared snapshot builder supplies identity with -c. These two data
  // values cannot select an executable; no other global override is accepted.
  while (remaining[0] === '-c' && /^user\.(name|email)=/.test(remaining[1] ?? '')) {
    identity.push(...remaining.slice(0, 2))
    remaining = remaining.slice(2)
  }
  const [command, ...rest] = remaining
  // Only the explicit commit tool uses this profile, after shell authorization.
  // Keep the argv intact (including hooks/signing config), without shell parsing.
  if (policy === 'user-command') {
    if (command !== 'add' && command !== 'commit') {
      throw new Error(`Unsupported user Git command: ${command ?? '(missing)'}`)
    }
    return [
      '--no-pager',
      '-c',
      'color.ui=false',
      ...(signing
        ? [
            '-c',
            'commit.gpgSign=true',
            '-c',
            'gpg.format=ssh',
            '-c',
            `gpg.ssh.program=${signing.program}`,
            '-c',
            `user.signingKey=key::${signing.publicKey}`,
          ]
        : []),
      ...args,
    ]
  }
  if (!command || !INTERNAL_GIT_COMMANDS.has(command)) {
    throw new Error(`Unsupported internal Git command: ${command ?? '(missing)'}`)
  }
  // A caller cannot prepend -c/--config-env to undo the policy. Diff flags go
  // before revisions/pathspecs, never after a caller's `--` separator.
  const diffFlags =
    command === 'diff' || command === 'show' || command === 'log'
      ? ['--no-ext-diff', '--no-textconv']
      : []
  return [
    '--no-pager',
    // `config` itself does not dispatch these helpers. Inspection must see the
    // actual values, including includes, rather than our execution overrides.
    ...(command === 'config' ? [] : INTERNAL_GIT_CONFIG.flatMap((entry) => ['-c', entry])),
    ...identity,
    command,
    ...diffFlags,
    ...rest,
  ]
}

/** Strip inherited Git execution/config injection; preserve explicit index/identity env. */
export function internalGitEnv(base: NodeJS.ProcessEnv, transport = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (
      key.startsWith('GIT_CONFIG') ||
      [
        'GIT_EXTERNAL_DIFF',
        'GIT_DIFF_OPTS',
        'GIT_EXEC_PATH',
        'GIT_SSH',
        'GIT_SSH_COMMAND',
        'GIT_SSH_VARIANT',
        'GIT_PROXY_COMMAND',
        'GIT_ASKPASS',
        'SSH_ASKPASS',
        'SSH_ASKPASS_REQUIRE',
        'GIT_DIR',
        'GIT_COMMON_DIR',
        'GIT_WORK_TREE',
      ].includes(key)
    ) {
      continue
    }
    env[key] = value
  }
  // Internal callers are local operations. In particular, missing objects in a
  // partial clone must not silently invoke a transport/remote helper.
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: transport ? 'https:http:ssh:file' : '',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  }
}
