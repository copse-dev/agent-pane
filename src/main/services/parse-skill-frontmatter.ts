import type { SkillMetadata, SkillSource } from '@shared/types/skills.ts'

export interface ParsedSkillFile {
  name: string
  description: string
  disableModelInvocation: boolean
  paths: string[]
}

export function splitSkillMarkdown(raw: string): { frontmatter: string; body: string } | null {
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return null
  const frontmatter = raw.slice(4, end).replace(/^\n/, '')
  const body = raw.slice(end + 4).replace(/^\n+/, '')
  return { frontmatter, body }
}

function parseScalarBlock(yaml: string, key: string): string | undefined {
  const blockRe = new RegExp(`^${key}:\\s*>\\-?\\s*\\n((?: {2}.+\\n?)*)`, 'm')
  const block = yaml.match(blockRe)
  if (block) {
    return block[1]!
      .split('\n')
      .map((line) => line.replace(/^ {2}/, ''))
      .join(' ')
      .trim()
  }
  const inlineRe = new RegExp(`^${key}:\\s*(.+)$`, 'm')
  const inline = yaml.match(inlineRe)
  if (!inline) return undefined
  return inline[1]!.replace(/^['"]|['"]$/g, '').trim()
}

function parseBoolean(yaml: string, key: string): boolean {
  const re = new RegExp(`^${key}:\\s*(true|false)\\s*$`, 'm')
  const match = yaml.match(re)
  return match?.[1] === 'true'
}

function parsePaths(yaml: string): string[] {
  const listRe = /^paths:\s*\n((?:\s+-\s+.+\n?)+)/m
  const list = yaml.match(listRe)
  if (list) {
    return list[1]!
      .split('\n')
      .map((line) =>
        line
          .match(/^\s+-\s+(.+)$/)?.[1]
          ?.replace(/^['"]|['"]$/g, '')
          .trim(),
      )
      .filter((value): value is string => !!value)
  }
  const inline = parseScalarBlock(yaml, 'paths')
  if (!inline) return []
  return inline
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function parseSkillFrontmatter(yaml: string): ParsedSkillFile | null {
  const name = parseScalarBlock(yaml, 'name')
  const description = parseScalarBlock(yaml, 'description')
  if (!name || !description) return null
  return {
    name,
    description,
    disableModelInvocation: parseBoolean(yaml, 'disable-model-invocation'),
    paths: parsePaths(yaml),
  }
}

export function folderNameMatchesSkill(skillPath: string, name: string): boolean {
  const parts = skillPath.split(/[/\\]/)
  const folder = parts[parts.length - 2]
  return folder === name
}

export function toSkillMetadata(
  parsed: ParsedSkillFile,
  skillPath: string,
  source: SkillSource,
): SkillMetadata {
  const parts = skillPath.split(/[/\\]/)
  parts.pop()
  const skillRoot = parts.join('/')
  return {
    name: parsed.name,
    description: parsed.description,
    source,
    skillPath,
    skillRoot,
    disableModelInvocation: parsed.disableModelInvocation,
    paths: parsed.paths,
  }
}
