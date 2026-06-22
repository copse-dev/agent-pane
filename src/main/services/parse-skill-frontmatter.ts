import type { SkillMetadata, SkillSource } from '@shared/types/skills.ts'

export interface ParsedSkillFile {
  name: string
  description: string
  disableModelInvocation: boolean
  paths: string[]
}

/**
 * Split a SKILL.md into its leading YAML frontmatter block and the body.
 *
 * The frontmatter is the region between an opening `---` line (which must be the
 * very first line of the file) and the next line that is exactly `---` (a closing
 * fence on its own line). Earlier versions matched the first `\n---` substring,
 * which let a `---` appearing *inside* a fenced code block — or a `----` rule —
 * prematurely terminate (or be mistaken for) the frontmatter. We now scan
 * line-by-line and only treat a standalone `---` line as the terminator.
 */
export function splitSkillMarkdown(raw: string): { frontmatter: string; body: string } | null {
  // Normalize CRLF so closing-fence detection is newline-agnostic.
  const text = raw.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null

  let closeIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      closeIndex = i
      break
    }
  }
  if (closeIndex === -1) return null

  const frontmatter = lines.slice(1, closeIndex).join('\n')
  const body = lines
    .slice(closeIndex + 1)
    .join('\n')
    .replace(/^\n+/, '')
  return { frontmatter, body }
}

/**
 * Fully unwrap a YAML flow scalar: strip matched surrounding quotes (possibly
 * nested, as a defensive measure against doubly-quoted untrusted input) and
 * decode the escape sequences YAML defines for double-quoted scalars.
 */
function unwrapScalar(value: string): string {
  let v = value.trim()
  // Strip a trailing line comment on unquoted scalars (e.g. `name: foo # note`).
  // Only when the value is not itself quoted.
  while (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = v.slice(1, -1)
      if (first === '"') {
        v = inner.replace(/\\(["\\/ntr])/g, (_, c: string) => {
          switch (c) {
            case 'n':
              return '\n'
            case 't':
              return '\t'
            case 'r':
              return '\r'
            default:
              return c
          }
        })
      } else {
        // Single-quoted YAML: only '' escapes to a literal quote.
        v = inner.replace(/''/g, "'")
      }
    } else {
      break
    }
  }
  return v.trim()
}

function parseScalarBlock(yaml: string, key: string): string | undefined {
  // Folded/literal block scalar: `key: >` or `key: |` (with optional chomping).
  const blockRe = new RegExp(`^${key}:[ \\t]*[>|][+-]?[ \\t]*\\n((?:(?:[ \\t]+.*)?\\n?)*)`, 'm')
  const block = yaml.match(blockRe)
  if (block && block[1] && /\S/.test(block[1])) {
    const lines = block[1].split('\n')
    // Indentation of the block is the indent of its first non-empty line.
    const firstContent = lines.find((l) => l.trim().length > 0) ?? ''
    const indent = firstContent.match(/^[ \t]+/)?.[0].length ?? 2
    return lines
      .map((line) => line.slice(indent))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  const inlineRe = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm')
  const inline = yaml.match(inlineRe)
  if (!inline) return undefined
  const rawValue = inline[1]!
  if (rawValue.trim().length === 0) return undefined
  return unwrapScalar(rawValue)
}

function parseBoolean(yaml: string, key: string): boolean {
  const value = parseScalarBlock(yaml, key)
  if (value === undefined) return false
  return /^(true|yes|on)$/i.test(value.trim())
}

function parsePaths(yaml: string): string[] {
  const listRe = /^paths:[ \t]*\n((?:[ \t]+-[ \t]+.+\n?)+)/m
  const list = yaml.match(listRe)
  if (list) {
    return list[1]!
      .split('\n')
      .map((line) => line.match(/^[ \t]+-[ \t]+(.+)$/)?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => unwrapScalar(value))
      .filter(Boolean)
  }
  const inline = parseScalarBlock(yaml, 'paths')
  if (!inline) return []
  return inline
    .split(',')
    .map((part) => unwrapScalar(part))
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
