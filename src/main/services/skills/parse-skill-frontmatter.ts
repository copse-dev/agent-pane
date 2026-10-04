import type { SkillMetadata, SkillSource } from '@shared/types/skills.ts'
import {
  parseScalarBlock,
  parseYamlBoolean,
  parseYamlList,
  splitMarkdownFrontmatter,
} from '../discovery/yaml-frontmatter.ts'

export interface ParsedSkillFile {
  name: string
  description: string
  disableModelInvocation: boolean
  paths: string[]
}

/**
 * Split a SKILL.md into its leading YAML frontmatter block and the body.
 *
 * Thin alias over the shared reader ({@link splitMarkdownFrontmatter}); kept
 * under this name because several callers import it from here.
 */
export const splitSkillMarkdown = splitMarkdownFrontmatter

export type SkillFrontmatterResult =
  | { skill: ParsedSkillFile; reason: null }
  | { skill: null; reason: string; name: string | undefined }

/** Name constraints and required fields, without changing the shared scalar dialect. */
export function validateSkillFrontmatter(yaml: string): SkillFrontmatterResult {
  const name = parseScalarBlock(yaml, 'name')
  const description = parseScalarBlock(yaml, 'description')
  const invalid = (reason: string): SkillFrontmatterResult => ({ skill: null, reason, name })
  if (!name) return invalid('frontmatter requires a non-empty `name` field')
  if (name.length > 64) return invalid('frontmatter `name` must be at most 64 characters')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return invalid(
      'frontmatter `name` must contain lowercase letters, digits, and single hyphens between words',
    )
  }
  if (!description) return invalid('frontmatter requires a non-empty `description` field')
  return {
    skill: {
      name,
      description,
      disableModelInvocation: parseYamlBoolean(yaml, 'disable-model-invocation'),
      paths: parseYamlList(yaml, 'paths'),
    },
    reason: null,
  }
}

export function parseSkillFrontmatter(yaml: string): ParsedSkillFile | null {
  return validateSkillFrontmatter(yaml).skill
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
  externalLinks: string[] = [],
  missingReferences: string[] = [],
  plugin?: string,
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
    externalLinks,
    missingReferences,
    ...(plugin ? { plugin } : {}),
  }
}
