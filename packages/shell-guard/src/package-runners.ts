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
 * Every spelling npm resolves to `init`: its aliases `create` and `innit`, and
 * their unique abbreviations (`npm cr vite` is `npm create vite`). Checked
 * against the command lists of npm 10.9.9 and 11.19.1.
 */
const NPM_INIT_SPELLINGS = new Set([
  'init',
  'ini',
  'innit',
  'inn',
  'inni',
  'create',
  'creat',
  'crea',
  'cre',
  'cr',
])

const NO_OPTIONS: ReadonlySet<string> = new Set()

/** Global options a manager takes that need no value: the word after one is the subcommand. */
function plainGlobalOptions(manager: string): ReadonlySet<string> {
  if (manager === 'npm') return NPM_PLAIN_OPTIONS
  if (manager === 'pnpm') return PNPM_GLOBAL_PLAIN_OPTIONS
  return NO_OPTIONS
}

/**
 * Subcommands that download the package they run, by manager: `always`
 * whatever follows, and `withInitializer` once any word follows the
 * subcommand. `npm init <initializer>` runs `create-<initializer>`; a bare
 * `npm init -y` only writes a package.json.
 */
const DOWNLOADING_SUBCOMMANDS: ReadonlyMap<
  string,
  { always: ReadonlySet<string>; withInitializer: ReadonlySet<string> }
> = new Map([
  ['npm', { always: NO_OPTIONS, withInitializer: NPM_INIT_SPELLINGS }],
  ['pnpm', { always: new Set(['dlx']), withInitializer: new Set(['create']) }],
  ['yarn', { always: new Set(['dlx']), withInitializer: new Set(['create']) }],
  ['bun', { always: new Set(['x']), withInitializer: new Set(['create']) }],
  ['pipx', { always: new Set(['run']), withInitializer: NO_OPTIONS }],
])

/** Runners that are nothing but a download-and-run. */
const DOWNLOADING_COMMANDS = new Set(['bunx', 'uvx'])

/**
 * A manager's other executable names, as the command each one runs. `yarnpkg`
 * is Yarn under the name Debian kept free. `pnpx` is `pnpm dlx` (pnpm 10.34.5's
 * `pnpx --help` prints `Usage: pnpm dlx`): it runs the named package in a
 * temporary environment and never a project binary, so it is not `npx`.
 */
const MANAGER_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['yarnpkg', ['yarn']],
  ['pnpx', ['pnpm', 'dlx']],
])

/**
 * `argv` as the package manager receives it, with the manager named canonically:
 * a backslash-newline's empty word dropped, `corepack <manager>[@<version>]`
 * replaced by the manager it runs, and an alias by the command it runs
 * (`yarnpkg` → `yarn`, `pnpx` → `pnpm dlx`).
 * shell-quote reads a backslash-newline as an empty word, so `npx \⏎ evil` would
 * name a package of `''`; the shell joins the lines, and no manager runs an
 * empty name. corepack takes a version pin on the manager's name
 * (`corepack pnpm@10.34.5 exec`), which must not hide it. Every check that reads
 * a manager's subcommand goes through this, so a spelling it accepts cannot
 * reach a check that only knows another.
 */
export function packageManagerArgv(argv: readonly string[]): string[] {
  let words = argv.filter((word) => word !== '')
  if (commandName(words[0]) === 'corepack') {
    const manager = /^([a-z]+)(?:@.*)?$/.exec(words[1] ?? '')?.[1]
    if (manager !== undefined && COREPACK_MANAGERS.has(manager)) {
      words = [manager, ...words.slice(2)]
    }
  }
  const alias = MANAGER_ALIASES.get(commandName(words[0]))
  return alias === undefined ? words : [...alias, ...words.slice(1)]
}

/**
 * The index of `subcommand` in `argv` when only global options precede it, or
 * -1 when another subcommand comes first. Records the first option outside
 * `plain`.
 *
 * An option in `plain` takes no value, so the word after it is the subcommand.
 * Any other option may take one (`--prefix /tmp`, `--filter app`), so one word
 * after it is skipped as its value, unless it is spelled `--opt=value`. Asking
 * that the subcommand come straight after a value word instead let any option
 * between them hide it: `npm --prefix /tmp --silent exec evil` was no runner
 * call at all. A misread here only matters with an unmodelled option present,
 * and that prompts wherever the subcommand turns out to be.
 */
function subcommandIndex(
  argv: readonly string[],
  subcommands: ReadonlySet<string>,
  plain: ReadonlySet<string>,
  unmodelled: { option: string | null } = { option: null },
): number {
  let valueMayFollow = false
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (subcommands.has(token)) return i
    if (token.startsWith('-')) {
      if (!plain.has(token)) unmodelled.option ??= token
      valueMayFollow = !plain.has(token) && !token.includes('=')
      continue
    }
    if (!valueMayFollow) return -1
    valueMayFollow = false
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
  if (head === 'npx') return npmExecCall(head, words.slice(1), null)
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

/**
 * The runner `argv` downloads a package with (`pnpm dlx`, `npm create`, `bunx`),
 * or null. The subcommand is found past global options as `packageRunnerCall`
 * finds `exec`: `pnpm --silent dlx` and `corepack pnpm -C sub dlx` download as
 * `pnpm dlx` does. Asking that it be the second word let any global option
 * hide it.
 *
 * An initializer is any word after the subcommand, even one after an option. It
 * may be that option's value (`npm init -w packages/a` asks), but npm runs
 * `npm init --force vite` as `create-vite`, and the gate cannot tell which
 * options take a value.
 */
export function downloadingRunner(argv: readonly string[]): string | null {
  const words = packageManagerArgv(argv)
  const head = commandName(words[0])
  if (DOWNLOADING_COMMANDS.has(head)) return head
  const forms = DOWNLOADING_SUBCOMMANDS.get(head)
  if (forms === undefined) return null
  const subcommands = new Set([...forms.always, ...forms.withInitializer])
  const at = subcommandIndex(words, subcommands, plainGlobalOptions(head))
  if (at < 0) return null
  const sub = words[at] ?? ''
  if (forms.always.has(sub)) return `${head} ${sub}`
  const named = words.slice(at + 1).some((word) => !word.startsWith('-'))
  return named ? `${head} ${sub}` : null
}

/** A package or binary name (`tsc`, `@scope/tool`): never a path, version spec or URL. */
export function isPlainPackageName(name: string): boolean {
  return /^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)
}

/** The `node_modules/.bin` entry a package name runs: its scope is dropped. */
export function packageBinName(name: string): string {
  return name.replace(/^@[^/]+\//, '')
}
