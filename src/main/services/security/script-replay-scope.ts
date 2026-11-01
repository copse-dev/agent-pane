import { realpathSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse } from 'shell-quote'
import { scanShellComposition } from './command-routing.ts'

const SCRIPT_SUFFIXES: ReadonlyMap<string, RegExp> = new Map([
  ['node', /\.(?:[cm]?js|[cm]?ts)$/],
  ['python', /\.py$/],
  ['python3', /\.py$/],
  ['ruby', /\.rb$/],
  ['sh', /\.sh$/],
  ['bash', /\.(?:sh|bash)$/],
  ['zsh', /\.(?:sh|zsh)$/],
])

/**
 * Literal argv only: shell evaluation must never become part of an argument grant.
 * Single-quoted source code is data, including its parentheses and dollar signs.
 */
function literalArgv(command: string): string[] | null {
  let quote: "'" | '"' | null = null
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '\\') {
      // Line continuation and trailing escapes are deliberately unsupported.
      if (!command.charAt(index + 1) || command.charAt(index + 1) === '\n') return null
      index++
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (char === '"' || (quote === null && char === "'")) {
      quote = char
      continue
    }
    if (char === '$' || char === '`') return null
    if (quote === null && /[(){}~*?[\]<>#]/.test(char)) return null
  }
  if (quote !== null) return null
  try {
    const tokens = parse(command)
    return tokens.every((token) => typeof token === 'string') ? tokens : null
  } catch {
    return null
  }
}

/**
 * Scope for explicitly approved argument changes to one existing local script.
 * Interpreter options/wrappers are unsupported and retain exact-command grants.
 * An optional literal cd is fixed as part of the grant; no other shell structure
 * is accepted. Resolve symlinks at issuance and replay, keeping the script local.
 */
export function scriptReplayScope(command: string, executionRoot: string): string | null {
  const composition = scanShellComposition(command)
  if (!composition) return null
  let cwd = executionRoot
  let prefix = ''
  let segment = composition.segments[0]
  if (composition.segments.length === 2 && composition.operators[0] === '&&') {
    prefix = composition.segments[0] ?? ''
    const cd = literalArgv(prefix)
    if (cd?.length !== 2 || cd[0] !== 'cd' || !cd[1] || cd[1].startsWith('-')) return null
    cwd = resolve(executionRoot, cd[1])
    segment = composition.segments[1]
  } else if (composition.segments.length !== 1 || composition.operators.length !== 0) {
    return null
  }
  if (!segment) return null
  const argv = literalArgv(segment)
  const interpreter = argv?.[0]
  const script = argv?.[1]
  if (!interpreter || !script || script.startsWith('-')) return null
  const suffix = SCRIPT_SUFFIXES.get(basename(interpreter))
  if (!suffix?.test(script)) return null
  try {
    const root = realpathSync(executionRoot)
    const directory = realpathSync(cwd)
    const path = realpathSync(resolve(directory, script))
    for (const target of [directory, path]) {
      const local = relative(root, target)
      if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return null
    }
    return JSON.stringify({ prefix, interpreter, directory, path })
  } catch {
    return null
  }
}
