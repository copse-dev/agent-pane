import { globSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SshConfigAlias } from '@shared/types/ssh-workspace.ts'

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

function isValidAlias(alias: string): boolean {
  return alias !== '*' && !alias.includes('*') && !alias.includes('?')
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Resolve an Include path relative to the including file (OpenSSH semantics). */
export function resolveSshIncludePath(pattern: string, includingFile: string): string {
  const expanded = expandHome(unquoteConfigValue(pattern))
  if (isAbsolute(expanded)) return expanded
  return resolve(dirname(includingFile), expanded)
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
    const line = rawLine.split('#')[0]?.trim() ?? ''
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
    const line = rawLine.split('#')[0]?.trim() ?? ''
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
 * files like `~/.ssh/ddg/*` appear in the import picker.
 */
export function readSshConfigAliases(
  configPath = join(homedir(), '.ssh', 'config'),
): SshConfigAlias[] {
  const aliases: SshConfigAlias[] = []
  const seenAlias = new Set<string>()
  const visitedFiles = new Set<string>()
  const queue: string[] = [resolve(configPath)]

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
      const resolved = resolveSshIncludePath(pattern, file)
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
