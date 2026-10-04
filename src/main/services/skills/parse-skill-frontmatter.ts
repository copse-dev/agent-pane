import { load, CORE_SCHEMA } from 'js-yaml'
import { z } from 'zod'
import type { SkillMetadata, SkillSource } from '@shared/types/skills.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { splitMarkdownFrontmatter } from '../discovery/yaml-frontmatter.ts'

const stringMetadata = z.unknown().transform((value, ctx): Record<string, string> => {
  if (!isRecord(value)) {
    ctx.addIssue({ code: 'custom', message: 'must be a mapping of string keys to string values' })
    return z.NEVER
  }
  const entries: Array<[string, string]> = []
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      ctx.addIssue({ code: 'custom', message: 'must contain only string values' })
      return z.NEVER
    }
    entries.push([key, entry])
  }
  // Object.fromEntries defines own properties even for __proto__ and constructor.
  // Do not merge author-controlled metadata into configuration or permissions.
  return Object.fromEntries(entries)
})

const skillSchema = z.object({
  name: z
    .string({ error: 'requires a non-empty name string' })
    .min(1, 'requires a non-empty name')
    .max(64, 'must be at most 64 characters')
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'must contain lowercase letters, digits, and single hyphens between words',
    ),
  description: z
    .string({ error: 'requires a non-empty description string' })
    .refine((value) => Array.from(value).length <= 1024, 'must be at most 1024 characters')
    .trim()
    .min(1, 'requires a non-empty description'),
  license: z.string().optional(),
  compatibility: z
    .string()
    .refine((value) => Array.from(value).length <= 500, 'must be at most 500 characters')
    .optional(),
  metadata: stringMetadata.optional(),
  'allowed-tools': z.string().optional(),
  'user-invocable': z.boolean().default(true),
  'disable-model-invocation': z.boolean().default(false),
  paths: z
    .union([
      z.array(z.string()),
      z.string().transform((value) =>
        value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ])
    .default([]),
})

export interface ParsedSkillFile {
  name: string
  description: string
  userInvocable: boolean
  disableModelInvocation: boolean
  paths: string[]
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string
}

export const splitSkillMarkdown = splitMarkdownFrontmatter

export type SkillFrontmatterResult =
  | { skill: ParsedSkillFile; reason: null; warnings: string[] }
  | { skill: null; reason: string; name: string | undefined; warnings: string[] }

/** Decode one bounded YAML document; unknown fields are descriptive diagnostics. */
export function validateSkillFrontmatter(yaml: string): SkillFrontmatterResult {
  const invalid = (reason: string, name?: string): SkillFrontmatterResult => ({
    skill: null,
    reason,
    name,
    warnings: [],
  })
  if (Buffer.byteLength(yaml, 'utf8') > 64 * 1024)
    return invalid('frontmatter exceeds the 64 KiB limit')
  let data: unknown
  try {
    data = load(yaml, { schema: CORE_SCHEMA, maxAliases: 0, maxDepth: 8 })
  } catch {
    return invalid(
      'frontmatter is malformed YAML (duplicate keys, aliases, custom tags, and deep collections are unsupported)',
    )
  }
  const name = isRecord(data) && typeof data['name'] === 'string' ? data['name'] : undefined
  const parsed = skillSchema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.map(String).join('.') ?? ''
    const field = path.length ? path : 'header'
    return invalid(`frontmatter ${field}: ${issue?.message ?? 'invalid value'}`, name)
  }
  const fields = parsed.data
  const warnings = isRecord(data)
    ? Object.keys(data)
        .filter((key) => !Object.hasOwn(skillSchema.shape, key))
        .sort()
        .map((key) => `Unsupported field "${key}" is ignored`)
    : []
  return {
    skill: {
      name: fields.name,
      description: fields.description,
      userInvocable: fields['user-invocable'],
      disableModelInvocation: fields['disable-model-invocation'],
      paths: fields.paths,
      ...(fields.license !== undefined ? { license: fields.license } : {}),
      ...(fields.compatibility !== undefined ? { compatibility: fields.compatibility } : {}),
      ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
      ...(fields['allowed-tools'] !== undefined ? { allowedTools: fields['allowed-tools'] } : {}),
    },
    reason: null,
    warnings,
  }
}

export function parseSkillFrontmatter(yaml: string): ParsedSkillFile | null {
  return validateSkillFrontmatter(yaml).skill
}

export function folderNameMatchesSkill(skillPath: string, name: string): boolean {
  const parts = skillPath.split(/[/\\]/)
  return parts[parts.length - 2] === name
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
  return {
    ...parsed,
    source,
    skillPath,
    skillRoot: parts.join('/'),
    externalLinks,
    missingReferences,
    ...(plugin ? { plugin } : {}),
  }
}
