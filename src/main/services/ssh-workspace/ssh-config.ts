import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshConfigAlias } from '@shared/types/ssh-workspace.ts'

function parsePort(value: string): number | undefined {
  const port = Number.parseInt(value.trim(), 10)
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
    const space = line.indexOf(' ')
    if (space === -1) continue
    const key = line.slice(0, space).toLowerCase()
    const value = line.slice(space + 1).trim()
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
        block.identityFile = value.replace(/^~/, homedir())
        break
      default:
        break
    }
  }
  flush()
  return aliases
}

export function readSshConfigAliases(
  configPath = join(homedir(), '.ssh', 'config'),
): SshConfigAlias[] {
  try {
    return parseSshConfig(readFileSync(configPath, 'utf8'))
  } catch {
    return []
  }
}
