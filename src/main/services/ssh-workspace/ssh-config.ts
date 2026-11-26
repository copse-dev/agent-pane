import { globSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SshConfigAlias } from '@shared/types/ssh-workspace.ts'
import { sshDestinationProblem } from '@shared/ssh-destination.ts'

function unquoteConfigValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parsePort(value: string): number | undefined {
  const port = Number.parseInt(unquoteConfigValue(value), 10)
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : undefined
}

interface ConfigBlock {
  aliases: string[]
  hostname?: string
  user?: string
  port?: number
  identityFile?: string
}

/**
 * A concrete host name: not a wildcard, not a `!pattern` negation (which
 * excludes, never names), and usable as an ssh destination (not starting with
 * `-`, which ssh would read as an option).
 */
function isValidAlias(alias: string): boolean {
  return (
    !alias.startsWith('!') &&
    !alias.includes('*') &&
    !alias.includes('?') &&
    sshDestinationProblem(alias, undefined) === null
  )
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve an Include path. OpenSSH reads a relative path against the directory
 * of the user configuration file (`~/.ssh`), wherever the `Include` itself is
 * written — so `rootConfigFile` is the top-level config, not a nested include.
 */
export function resolveSshIncludePath(pattern: string, rootConfigFile: string): string {
  const expanded = expandHome(unquoteConfigValue(pattern))
  if (isAbsolute(expanded)) return expanded
  return resolve(dirname(rootConfigFile), expanded)
}

/**
 * Drop a comment from a config line. As in OpenSSH, `#` starts one only at the
 * beginning of a word and outside quotes: `IdentityFile ~/.ssh/id#work` and
 * `"my #key"` keep theirs.
 */
function stripConfigComment(rawLine: string): string {
  let quote: string | null = null
  for (let i = 0; i < rawLine.length; i++) {
    const char = rawLine.charAt(i)
    if (quote !== null) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#' && (i === 0 || /\s/.test(rawLine.charAt(i - 1)))) {
      return rawLine.slice(0, i).trim()
    }
  }
  return rawLine.trim()
}

/** Parse OpenSSH `Host` stanzas from a config file (best-effort, no full ssh-config semantics). */
export function parseSshConfig(content: string): SshConfigAlias[] {
  const aliases: SshConfigAlias[] = []
  let block: ConfigBlock | null = null

  const flush = (): void => {
    if (!block || block.aliases.length === 0) {
      block = null
      return
    }
    for (const alias of block.aliases) {
      const entry: SshConfigAlias = { alias }
      if (block.hostname) entry.hostname = block.hostname
      if (block.user) entry.user = block.user
      if (block.port !== undefined) entry.port = block.port
      if (block.identityFile) entry.identityFile = block.identityFile
      aliases.push(entry)
    }
    block = null
  }

  for (const rawLine of content.split('\n')) {
    const line = stripConfigComment(rawLine)
    if (!line) continue
    // Support both `Key value` and `Key=value` (some configs use the latter).
    const match = /^(?<key>[A-Za-z][A-Za-z0-9*]*)(?:\s+|=)(?<value>.+)$/.exec(line)
    if (!match?.groups) continue
    const key = match.groups['key']?.toLowerCase() ?? ''
    const value = unquoteConfigValue(match.groups['value']?.trim() ?? '')
    if (!value) continue

    if (key === 'host') {
      flush()
      block = {
        aliases: value.split(/\s+/).filter(isValidAlias),
      }
      continue
    }
    if (key === 'match') {
      // A Match block's options apply conditionally, never to the preceding Host.
      flush()
      continue
    }

    if (!block) continue
    switch (key) {
      case 'hostname':
        block.hostname = value
        break
      case 'user':
        block.user = value
        break
      case 'port': {
        const port = parsePort(value)
        if (port !== undefined) block.port = port
        break
      }
      case 'identityfile':
        block.identityFile = expandHome(value)
        break
      default:
        break
    }
  }
  flush()
  return aliases
}

function collectIncludePatterns(content: string): string[] {
  const patterns: string[] = []
  for (const rawLine of content.split('\n')) {
    const line = stripConfigComment(rawLine)
    if (!line) continue
    const match = /^(?<key>[A-Za-z][A-Za-z0-9*]*)(?:\s+|=)(?<value>.+)$/.exec(line)
    if (!match?.groups) continue
    if ((match.groups['key'] ?? '').toLowerCase() !== 'include') continue
    const value = match.groups['value']?.trim() ?? ''
    if (!value) continue
    // Include accepts multiple whitespace-separated glob patterns.
    for (const part of value.split(/\s+/)) {
      const pattern = unquoteConfigValue(part)
      if (pattern) patterns.push(pattern)
    }
  }
  return patterns
}

const MAX_INCLUDE_FILES = 64

/**
 * Read `~/.ssh/config` (or `configPath`) and follow `Include` globs so hosts in
 * files like `~/.ssh/team/*` appear in the import picker.
 */
export function readSshConfigAliases(
  configPath = join(homedir(), '.ssh', 'config'),
): SshConfigAlias[] {
  const aliases: SshConfigAlias[] = []
  const seenAlias = new Set<string>()
  const visitedFiles = new Set<string>()
  const rootConfig = resolve(configPath)
  const queue: string[] = [rootConfig]

  while (queue.length > 0 && visitedFiles.size < MAX_INCLUDE_FILES) {
    const file = queue.shift()
    if (!file || visitedFiles.has(file)) continue
    visitedFiles.add(file)

    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    for (const entry of parseSshConfig(content)) {
      if (seenAlias.has(entry.alias)) continue
      seenAlias.add(entry.alias)
      aliases.push(entry)
    }

    for (const pattern of collectIncludePatterns(content)) {
      const resolved = resolveSshIncludePath(pattern, rootConfig)
      let matches: string[]
      try {
        matches = globSync(resolved)
      } catch {
        continue
      }
      for (const matchPath of matches.sort()) {
        const abs = resolve(matchPath)
        try {
          if (!statSync(abs).isFile()) continue
        } catch {
          continue
        }
        if (!visitedFiles.has(abs)) queue.push(abs)
      }
    }
  }

  return aliases
}
