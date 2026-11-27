import { join } from 'node:path'
import { commandName } from './shell-argv.ts'
import { secretFileName } from './secrets.ts'

/**
 * The commands a task runner will run for one invocation: the recipe a `just`, `task` or
 * package-manager `run` names, read from the project file in the directory it runs in.
 * `make` is not read here; release target names are caught by `release-actions.ts`.
 *
 * Used only by the Guarded YOLO harm gate, which asks about the release, secret and
 * outward-effect reasons those lines carry. A file it cannot read or parse yields nothing,
 * so the invocation is judged as written, as before.
 */
export interface TaskRecipe {
  /** How the runner was invoked, for reasons: `just preflight`, `pnpm run prepare:dist`. */
  label: string
  /** Shell command lines the recipe runs, dependencies first. */
  lines: string[]
  /** Reasons the runner's own settings carry, such as loading a `.env` file. */
  reasons: string[]
}

type Read = (path: string) => string | null

const LISTING =
  /^(?:--list|-l|--summary|--show|-s|--dry-run|-n|--help|-h|--version|--evaluate|--dump|--choose|--edit|--init|--fmt)$/
const MAX_RECIPE_LINES = 200

function firstOperand(
  argv: readonly string[],
  valueOptions: ReadonlySet<string>,
): string | undefined {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (valueOptions.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-') || /^[A-Za-z_]\w*=/.test(arg)) continue
    return arg
  }
  return undefined
}

// --- just ---------------------------------------------------------------------------------

const JUST_VALUE_OPTIONS = new Set([
  '-f',
  '--justfile',
  '-d',
  '--working-directory',
  '--set',
  '--shell',
  '--dotenv-filename',
  '--dotenv-path',
  '--color',
])

function justRecipe(argv: readonly string[], cwd: string, read: Read): TaskRecipe | null {
  if (argv.slice(1).some((arg) => LISTING.test(arg))) return null
  if (
    argv.some(
      (arg) =>
        JUST_VALUE_OPTIONS.has(arg) && arg !== '--set' && arg !== '--color' && arg !== '--shell',
    )
  )
    return null
  const text = ['justfile', 'Justfile', '.justfile']
    .map((name) => read(join(cwd, name)))
    .find((t) => t !== null)
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const recipes = new Map<string, { deps: string[]; body: string[] }>()
  let first: string | undefined
  let current: { deps: string[]; body: string[] } | null = null
  const reasons: string[] = []
  let dotenv = false
  let dotenvFile = '.env'
  for (const line of lines) {
    const setting =
      /^set\s+(dotenv-load|dotenv-filename|dotenv-path|dotenv-required)\s*(?::=\s*(.+))?$/.exec(
        line.trim(),
      )
    if (setting && !/^\s/.test(line)) {
      const value = (setting[2] ?? 'true').trim().replace(/^(['"])(.*)\1$/, '$2')
      if (setting[1] === 'dotenv-load' || setting[1] === 'dotenv-required')
        dotenv = value !== 'false'
      else {
        dotenv = true
        dotenvFile = value
      }
      continue
    }
    const header = /^@?([A-Za-z_][\w-]*)(?:\s+[^:=]*)?:(?!=)\s*(.*)$/.exec(line)
    if (header && !/^\s/.test(line)) {
      const deps = (header[2] ?? '')
        .replace(/#.*$/, '')
        .split(/\s+/)
        .filter((dep) => /^[A-Za-z_][\w-]*$/.test(dep))
      current = { deps, body: [] }
      recipes.set(header[1] ?? '', current)
      first ??= header[1]
      continue
    }
    if (current && /^\s+\S/.test(line)) {
      const body = line.trim().replace(/^[@-]+/, '')
      if (!body.startsWith('#')) current.body.push(body)
      continue
    }
    if (line.trim() !== '' && !line.trim().startsWith('#')) current = null
  }
  if (dotenv && !argv.includes('--no-dotenv') && secretFileName(dotenvFile)) {
    reasons.push(`loads a secret file into the recipe's environment (just: ${dotenvFile})`)
  }
  const name = firstOperand(argv, JUST_VALUE_OPTIONS) ?? first
  if (name === undefined) return reasons.length > 0 ? { label: 'just', lines: [], reasons } : null
  return { label: `just ${name}`, lines: expand(name, (n) => recipes.get(n)), reasons }
}

// --- go-task --------------------------------------------------------------------------------

const TASK_VALUE_OPTIONS = new Set([
  '-t',
  '--taskfile',
  '-d',
  '--dir',
  '-o',
  '--output',
  '-c',
  '--concurrency',
  '--interval',
])

function goTaskRecipe(argv: readonly string[], cwd: string, read: Read): TaskRecipe | null {
  if (
    argv
      .slice(1)
      .some(
        (arg) =>
          LISTING.test(arg) ||
          arg === '--list-all' ||
          arg === '-a' ||
          arg === '--dry' ||
          arg === '--status',
      )
  )
    return null
  if (argv.some((arg) => ['-t', '--taskfile', '-d', '--dir'].includes(arg))) return null
  const text = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml']
    .map((name) => read(join(cwd, name)))
    .find((t) => t !== null)
  if (!text) return null
  const tasks = new Map<string, { deps: string[]; body: string[] }>()
  const reasons: string[] = []
  let inTasks = false
  let taskIndent = -1
  let current: { deps: string[]; body: string[] } | null = null
  let list: 'cmds' | 'deps' | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (indent === 0) {
      inTasks = line === 'tasks:'
      current = null
      const dotenv = /^dotenv:\s*\[(.*)\]/.exec(line)
      for (const file of dotenv?.[1]?.split(',') ?? []) {
        const name = secretFileName(file.trim().replace(/^(['"])(.*)\1$/, '$2'))
        if (name)
          reasons.push(`loads a secret file into the task's environment (Taskfile: ${name})`)
      }
      continue
    }
    if (!inTasks) continue
    const key = /^([\w:.-]+):\s*(.*)$/.exec(line)
    if (key && (taskIndent === -1 || indent === taskIndent) && !line.startsWith('-')) {
      taskIndent = indent
      current = { deps: [], body: [] }
      tasks.set(key[1] ?? '', current)
      list = null
      continue
    }
    if (!current) continue
    const field = /^(cmds|deps|cmd):\s*(.*)$/.exec(line)
    if (field) {
      if (field[1] === 'cmd' && field[2]) current.body.push(unquote(field[2]))
      else if (field[1] === 'deps' && field[2]?.startsWith('[')) {
        current.deps.push(
          ...field[2]
            .slice(1, -1)
            .split(',')
            .map((d) => unquote(d.trim()))
            .filter(Boolean),
        )
      }
      list = field[1] === 'cmds' ? 'cmds' : field[1] === 'deps' ? 'deps' : null
      continue
    }
    const item = /^-\s+(?:(cmd|task):\s*)?(.+)$/.exec(line)
    if (item && list) {
      const value = unquote(item[2] ?? '')
      if (list === 'deps' || item[1] === 'task') current.deps.push(value)
      else current.body.push(value)
    } else if (/^[\w-]+:/.test(line)) list = null
  }
  const name = firstOperand(argv, TASK_VALUE_OPTIONS) ?? 'default'
  return { label: `task ${name}`, lines: expand(name, (n) => tasks.get(n)), reasons }
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2')
}

// --- package scripts --------------------------------------------------------------------------

/** Package-manager commands that are not scripts, for the bare `yarn <script>` form. */
const YARN_BUILTINS = new Set([
  'add',
  'install',
  'remove',
  'upgrade',
  'up',
  'why',
  'info',
  'init',
  'link',
  'unlink',
  'pack',
  'publish',
  'dlx',
  'exec',
  'workspace',
  'workspaces',
  'config',
  'cache',
  'set',
  'version',
  'npm',
  'plugin',
  'constraints',
  'dedupe',
  'explain',
  'patch',
  'rebuild',
  'run',
  'node',
  'bin',
  'audit',
  'outdated',
  'login',
  'logout',
  'global',
  'create',
  'import',
  'list',
  'licenses',
  'owner',
  'tag',
  'team',
  'test',
  'help',
])

function packageScript(
  head: string,
  argv: readonly string[],
  cwd: string,
  read: Read,
): TaskRecipe | null {
  if (
    argv.some((arg) =>
      /^(?:--filter|-F|-r|--recursive|-C|--dir|--prefix|--cwd|--workspace|-w|-ws|--workspaces|--if-present|--help|-h)(?:=|$)/.test(
        arg,
      ),
    )
  ) {
    return null
  }
  const words = argv.slice(1).filter((arg) => !arg.startsWith('-'))
  let name: string | undefined
  if (words[0] === 'run' || words[0] === 'run-script') name = words[1]
  else if (head === 'yarn' && words[0] && !YARN_BUILTINS.has(words[0])) name = words[0]
  else if (/^(?:test|start)$/.test(words[0] ?? '') && head !== 'bun') name = words[0]
  if (!name) return null
  const text = read(join(cwd, 'package.json'))
  if (!text) return null
  let scripts: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    const found =
      typeof parsed === 'object' && parsed !== null && 'scripts' in parsed ? parsed.scripts : null
    scripts = typeof found === 'object' && found !== null ? { ...found } : {}
  } catch {
    return null
  }
  const lines: string[] = []
  for (const key of [`pre${name}`, name, `post${name}`]) {
    const body = scripts[key]
    if (typeof body === 'string') lines.push(body)
  }
  return lines.length > 0 ? { label: `${head} run ${name}`, lines, reasons: [] } : null
}

// ---------------------------------------------------------------------------------------------

function expand(
  name: string,
  lookup: (name: string) => { deps: string[]; body: string[] } | undefined,
  seen = new Set<string>(),
): string[] {
  if (seen.has(name)) return []
  seen.add(name)
  const recipe = lookup(name)
  if (!recipe) return []
  const lines: string[] = []
  for (const dep of recipe.deps) lines.push(...expand(dep, lookup, seen))
  lines.push(...recipe.body)
  return lines.slice(0, MAX_RECIPE_LINES)
}

/** The recipe one unwrapped argv runs, read relative to `cwd`; null when it names none. */
export function taskRecipe(argv: readonly string[], cwd: string, read: Read): TaskRecipe | null {
  const head = commandName(argv[0])
  if (head === 'just') return justRecipe(argv, cwd, read)
  if (head === 'task' || head === 'go-task') return goTaskRecipe(argv, cwd, read)
  if (head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'bun') {
    return packageScript(head, argv, cwd, read)
  }
  return null
}
