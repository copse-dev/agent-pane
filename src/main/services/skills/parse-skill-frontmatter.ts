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

export function parseSkillFrontmatter(yaml: string): ParsedSkillFile | null {
  const name = parseScalarBlock(yaml, 'name')
  const description = parseScalarBlock(yaml, 'description')
  if (!name || !description) return null
  return {
    name,
    description,
    disableModelInvocation: parseYamlBoolean(yaml, 'disable-model-invocation'),
    paths: parseYamlList(yaml, 'paths'),
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
  externalLinks: string[] = [],
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
  }
}
