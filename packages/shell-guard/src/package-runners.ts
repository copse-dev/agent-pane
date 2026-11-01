import { commandName } from './shell-argv.ts'

/**
 * Package-manager commands that run a binary by name: `npx <name>`,
 * `npm exec <name>` and `pnpm exec <name>`. Each looks the name up in the
 * project's `node_modules/.bin` first, so the file it runs is one an agent can
 * write. `host-reach.ts` asks before a name that would be fetched, and
 * `shell-harm.ts` reads the project binary a name resolves to.
 */
export interface PackageRunnerCall {
  /** How the runner was spelled, for reasons: `npx`, `npm exec`, `pnpm exec`. */
  runner: string
  /** npm fetches a name the project does not provide; `pnpm exec` runs it from PATH. */
  fetches: boolean
  /** The command and its arguments, after the runner's own options. */
  command: string[]
  /** The `-p`/`--package` value: a package to fetch rather than a project binary. */
  packageOption: string | null
  /** `pnpm exec -c`: the command words are joined and run by a shell. */
  shellMode: boolean
  /**
   * The first option the gate does not model. It may choose another directory,
   * workspace package or package to run (`--prefix`, `--filter`, `-r`), so the
   * project binary cannot be known.
   */
  unmodelledOption: string | null
}

/** Options that change nothing about which file runs. */
const NPM_PLAIN_OPTIONS = new Set([
  '-y',
  '--yes',
  '--no',
  '--no-install',
  '-q',
  '--quiet',
  '-s',
  '--silent',
])
const PNPM_GLOBAL_PLAIN_OPTIONS = new Set(['-s', '--silent', '-w', '--workspace-root'])
const PNPM_SHELL_MODE_OPTIONS = new Set(['-c', '--shell-mode'])

/** Package managers corepack runs on the caller's behalf. */
const COREPACK_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg'])

/**
 * Every spelling npm resolves to `exec`. npm's `deref` accepts an alias (`x`)
 * and any unique abbreviation of a command or alias, so `npm exe evil` is
 * `npm exec evil`; `ex` is ambiguous with `explain` and `explore`. Checked
 * against npm 11.19.1's command list. pnpm has no other name for `exec`.
 */
const NPM_EXEC_SPELLINGS = new Set(['exec', 'exe', 'x'])

/**
 * `argv` as the package manager receives it: a backslash-newline's empty word
 * dropped, and `corepack <manager>[@<version>]` replaced by the manager it runs.
 * shell-quote reads a backslash-newline as an empty word, so `npx \⏎ evil` would
 * name a package of `''`; the shell joins the lines, and no manager runs an
 * empty name. corepack takes a version pin on the manager's name
 * (`corepack pnpm@10.34.5 exec`), which must not hide it.
 */
export function packageManagerArgv(argv: readonly string[]): string[] {
  const words = argv.filter((word) => word !== '')
  if (commandName(words[0]) !== 'corepack') return words
  const manager = /^([a-z]+)(?:@.*)?$/.exec(words[1] ?? '')?.[1]
  return manager !== undefined && COREPACK_MANAGERS.has(manager)
    ? [manager, ...words.slice(2)]
    : words
}

/**
 * The index of `subcommand` in `argv` when only global options precede it, or
 * -1. An option may take one value word (`pnpm --filter app exec`), the same
 * shape `shell-scope.ts` accepts. Records the first option outside `plain`.
 */
function subcommandIndex(
  argv: readonly string[],
  subcommands: ReadonlySet<string>,
  plain: ReadonlySet<string>,
  unmodelled: { option: string | null },
): number {
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (subcommands.has(token)) return i
    if (!token.startsWith('-')) {
      // A value word belongs to the option before it only when the subcommand follows.
      const previous = argv[i - 1] ?? ''
      if (i > 1 && previous.startsWith('-') && subcommands.has(argv[i + 1] ?? '')) continue
      return -1
    }
    if (!plain.has(token)) unmodelled.option ??= token
  }
  return -1
}

/**
 * Split an npm-style option list from the command it runs. Options other than
 * `-p`/`--package` take no value here, so the command is the first other word,
 * as `host-reach.ts` has always read it.
 */
function npmExecCall(
  runner: string,
  args: readonly string[],
  unmodelled: string | null,
): PackageRunnerCall {
  let packageOption: string | null = null
  let unmodelledOption = unmodelled
  let i = 0
  for (; i < args.length; i++) {
    const token = args[i] ?? ''
    if (token === '--') {
      i++
      break
    }
    if (!token.startsWith('-')) break
    if (token === '-p' || token === '--package') {
      packageOption = args[++i] ?? ''
      continue
    }
    if (token.startsWith('--package=')) {
      packageOption = token.slice('--package='.length)
      continue
    }
    if (!NPM_PLAIN_OPTIONS.has(token)) unmodelledOption ??= token
  }
  return {
    runner,
    fetches: true,
    command: args.slice(i),
    packageOption,
    shellMode: false,
    unmodelledOption,
  }
}

function pnpmExecCall(args: readonly string[], unmodelled: string | null): PackageRunnerCall {
  let shellMode = false
  let unmodelledOption = unmodelled
  let i = 0
  for (; i < args.length; i++) {
    const token = args[i] ?? ''
    if (token === '--') {
      i++
      break
    }
    if (!token.startsWith('-')) break
    if (PNPM_SHELL_MODE_OPTIONS.has(token)) shellMode = true
    else unmodelledOption ??= token
  }
  return {
    runner: 'pnpm exec',
    fetches: false,
    command: args.slice(i),
    packageOption: null,
    shellMode,
    unmodelledOption,
  }
}

/** The package runner `argv` invokes, or null when it is not one. */
export function packageRunnerCall(argv: readonly string[]): PackageRunnerCall | null {
  const words = packageManagerArgv(argv)
  const head = commandName(words[0])
  if (head === 'npx' || head === 'pnpx') return npmExecCall(head, words.slice(1), null)
  const unmodelled: { option: string | null } = { option: null }
  if (head === 'npm') {
    const at = subcommandIndex(words, NPM_EXEC_SPELLINGS, NPM_PLAIN_OPTIONS, unmodelled)
    if (at < 0) return null
    return npmExecCall(`npm ${words[at] ?? ''}`, words.slice(at + 1), unmodelled.option)
  }
  if (head === 'pnpm') {
    const at = subcommandIndex(words, new Set(['exec']), PNPM_GLOBAL_PLAIN_OPTIONS, unmodelled)
    if (at < 0) return null
    return pnpmExecCall(words.slice(at + 1), unmodelled.option)
  }
  return null
}

/** A package or binary name (`tsc`, `@scope/tool`): never a path, version spec or URL. */
export function isPlainPackageName(name: string): boolean {
  return /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)
}

/** The `node_modules/.bin` entry a package name runs: its scope is dropped. */
export function packageBinName(name: string): string {
  return name.replace(/^@[^/]+\//, '')
}
