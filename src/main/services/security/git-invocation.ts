/**
 * Internal Git operations are app plumbing, not permission-gated shell commands.
 * Keep their command vocabulary explicit: an unknown command could be a repo
 * alias or an external git-* executable. Additions need a config-execution audit.
 */
const INTERNAL_GIT_COMMANDS = new Set([
  '--version',
  'add',
  // Changes pane hunk staging. Only the shape `assertIndexApply` admits: the
  // patch comes on stdin and is applied to the index alone (`--cached`), so no
  // working-tree file is written and no smudge/clean filter or hook runs.
  'apply',
  'branch',
  // Carry-in/carry-out and hosted transfer bundles; `assertBundle` admits
  // create, verify and list-heads. Packing and reading a bundle consult no
  // configured program.
  'bundle',
  'cat-file',
  'check-ignore',
  'check-ref-format',
  // Patch ids use Git's internal diff: no external diff or textconv (those are
  // enabled only by the diff/log porcelains).
  'cherry',
  // Applying a container/hosted run's commits (`adoptCarryOut`). Only the exact
  // shape `assertCherryPick` admits: `--no-edit` (no editor) and full SHAs (no
  // `-s` strategy, which would run an external `git-merge-*`, and no `-S`).
  // Hooks, fsmonitor and signing are off through the overrides below; merge
  // drivers, like content filters, keep Git's semantics.
  'cherry-pick',
  // Only the local submodule clone `assertLocalSubmoduleClone` admits: no
  // checkout (so no hooks or smudge filters), no templates, and no option that
  // selects a helper program. `internalGitTransport` limits it to `file`.
  'clone',
  // User-requested commits go through a permission-gated execution profile, so
  // hooks/signing work there. Only automatic commit-tree snapshots belong here.
  'commit-tree',
  // Only the conversion-attribute read `assertAttributeRead` admits.
  'check-attr',
  'config',
  'diff',
  'fetch',
  'for-each-ref',
  // Revision searches for LFS markers. Only the exact shape `assertGrep`
  // admits, so no `-O` pager program and no textconv in any spelling.
  'grep',
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
export const INTERNAL_GIT_CONFIG = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  // fetch and push run this program to list an alternate object store's refs
  // when the checkout has `objects/info/alternates`. Empty means unset: Git
  // lists those refs itself, which only feeds negotiation.
  'core.alternateRefsCommand=',
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

export type GitConfigPolicy = 'internal' | 'internal-network' | 'user-command'

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
  if (command === 'clone') assertLocalSubmoduleClone(rest)
  if (command === 'check-attr') assertAttributeRead(rest)
  if (command === 'cherry-pick') assertCherryPick(rest)
  if (command === 'apply') assertIndexApply(rest)
  if (command === 'bundle') assertBundle(rest)
  if (command === 'grep') assertGrep(rest)
  // A caller cannot prepend -c/--config-env to undo the policy. Diff flags go
  // before revisions/pathspecs, never after a caller's `--` separator.
  const diffFlags =
    command === 'diff' || command === 'show' || command === 'log'
      ? ['--no-ext-diff', '--no-textconv']
      : command === 'grep'
        ? ['--no-textconv']
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

/**
 * Admit exactly `clone --no-checkout --template= --separate-git-dir <dir> -- <source> <target>`.
 *
 * Config-execution audit: with `--no-checkout` nothing is written to a working
 * tree, so no hook, smudge filter or fsmonitor runs; an empty `--template=`
 * installs no hooks into the new repository; `file` is the only transport (see
 * `internalGitTransport`), and a local clone copies objects and refs without
 * consulting the source's configuration. Every option that names a program or
 * writes configuration (`--upload-pack`, `--config`, `--recurse-submodules`, a
 * template directory) is refused rather than enumerated.
 */
function assertLocalSubmoduleClone(args: string[]): void {
  const [noCheckout, template, separateGitDir, gitDir, separator, source, target, ...extra] = args
  if (
    noCheckout !== '--no-checkout' ||
    template !== '--template=' ||
    separateGitDir !== '--separate-git-dir' ||
    !gitDir ||
    separator !== '--' ||
    !source ||
    !target ||
    extra.length > 0
  ) {
    throw new Error('Unsupported internal Git clone')
  }
}

/** The attribute read the only-copy audit makes (`git-service.ts`). */
const ADMITTED_ATTRIBUTE_READ = [
  '-z',
  '--stdin',
  'filter',
  'text',
  'crlf',
  'eol',
  'ident',
  'working-tree-encoding',
]

/**
 * Admit exactly `check-attr -z --stdin filter text crlf eol ident
 * working-tree-encoding`: it reads which paths git would convert on `add`, runs
 * no program and writes nothing.
 */
function assertAttributeRead(args: string[]): void {
  if (
    args.length !== ADMITTED_ATTRIBUTE_READ.length ||
    args.some((arg, index) => arg !== ADMITTED_ATTRIBUTE_READ[index])
  ) {
    throw new Error('Unsupported internal Git check-attr')
  }
}

const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/**
 * Admit exactly `cherry-pick --abort` or
 * `cherry-pick --no-edit [--allow-empty-message] <full sha>...`.
 *
 * Config-execution audit: `--no-edit` starts no editor; hooks
 * (prepare-commit-msg, post-commit, reference-transaction), fsmonitor and
 * signing are disabled by `INTERNAL_GIT_CONFIG`; full SHAs leave no room for a
 * `-s <strategy>` (an external `git-merge-<strategy>` program), `-S`, `-e` or
 * `-x`. Merge drivers and content filters that the checkout configures keep
 * Git's normal semantics, as for `switch` and `restore`.
 */
function assertCherryPick(args: string[]): void {
  if (args.length === 1 && args[0] === '--abort') return
  const [noEdit, ...rest] = args
  const commits = rest[0] === '--allow-empty-message' ? rest.slice(1) : rest
  if (noEdit !== '--no-edit' || commits.length === 0 || !commits.every((c) => FULL_SHA.test(c)))
    throw new Error('Unsupported internal Git cherry-pick')
}

/** The flags the hosted transfer's LFS scan passes. None takes a value. */
const GREP_FLAGS = new Set(['-I', '-l', '-E'])

/**
 * Admit exactly `grep [-I] [-l] [-E] <pattern> [<full sha>] [-- <path>...]`.
 *
 * Config-execution audit: `-O`/`--open-files-in-pager` runs the program named
 * in its argument, and `--textconv` after the injected `--no-textconv` runs the
 * checkout's textconv drivers. Git also accepts abbreviated long options
 * (`--open=<prog>`) and bundled short ones (`-IO<prog>`), so each flag must be
 * one of {@link GREP_FLAGS} exactly rather than avoid a known prefix. Git stops
 * parsing options at the first non-option, so a pattern that starts with `-`
 * would be read as one and is refused; after the pattern, only a full SHA and
 * `--` pathspecs are admitted.
 */
function assertGrep(args: string[]): void {
  const patternAt = args.findIndex((arg) => !GREP_FLAGS.has(arg))
  const [pattern, ...rest] = patternAt === -1 ? [] : args.slice(patternAt)
  const tail = FULL_SHA.test(rest[0] ?? '') ? rest.slice(1) : rest
  if (!pattern || pattern.startsWith('-') || (tail.length > 0 && tail[0] !== '--'))
    throw new Error('Unsupported internal Git grep')
}

/**
 * Admit exactly `apply --cached --unidiff-zero --whitespace=nowarn [--reverse] -`.
 * Every other option is refused rather than enumerated: none of these reads a
 * patch from a path or writes outside the index.
 */
function assertIndexApply(args: string[]): void {
  const expected = ['--cached', '--unidiff-zero', '--whitespace=nowarn']
  const reverse = args[3] === '--reverse'
  const tail = args.slice(reverse ? 4 : 3)
  if (expected.some((flag, i) => args[i] !== flag) || tail.length !== 1 || tail[0] !== '-') {
    throw new Error('Unsupported internal Git apply')
  }
}

/** Admit `bundle create|verify|list-heads`; `unbundle` and future subcommands are refused. */
function assertBundle(args: string[]): void {
  const [subcommand] = args
  if (subcommand !== 'create' && subcommand !== 'verify' && subcommand !== 'list-heads')
    throw new Error(`Unsupported internal Git bundle: ${subcommand ?? '(missing)'}`)
}

/**
 * The transports an internal command may use: the network remotes `fetch` and
 * `push` need, `file` alone for a local clone, and nothing for anything else.
 */
export function internalGitTransport(command: string | undefined): 'remote' | 'local' | 'none' {
  if (command === 'fetch' || command === 'push') return 'remote'
  if (command === 'clone') return 'local'
  return 'none'
}

/** Strip inherited Git execution/config injection; preserve explicit index/identity env. */
export function internalGitEnv(
  base: NodeJS.ProcessEnv,
  transport: ReturnType<typeof internalGitTransport> | 'network' = 'none',
): NodeJS.ProcessEnv {
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
        'GIT_NAMESPACE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      ].includes(key)
    ) {
      // Spawn merges this overlay over its inherited base. An explicit unset
      // must survive that merge; omitting the key would restore ambient config.
      env[key] = undefined
      continue
    }
    env[key] = value
  }
  // Internal callers are local operations. In particular, missing objects in a
  // partial clone must not silently invoke a transport/remote helper.
  return {
    ...env,
    GIT_ALLOW_PROTOCOL:
      transport === 'network'
        ? 'https:http:ssh'
        : transport === 'remote'
          ? 'https:http:ssh:file'
          : transport === 'local'
            ? 'file'
            : '',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  }
}
