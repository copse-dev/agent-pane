import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { readSkill } from '../services/skills-registry.ts'

export const readSkillTool: ToolDefinition = {
  name: 'read_skill',
  description:
    'Read a skill definition or a file under a skill directory (scripts/, references/, assets/). ' +
    'Use when the user invoked a skill via /skill-name or when you need skill instructions.',
  parameters: z.object({
    name: z.string().describe('Skill name from frontmatter, e.g. "demo-skill"'),
    path: z
      .string()
      .optional()
      .describe('Optional path relative to the skill root. Defaults to SKILL.md'),
  }),
  async execute({ name, path }) {
    const result = await readSkill(name, path ?? 'SKILL.md')
    const header = [
      `# Skill: ${result.name}`,
      `Root: ${result.skillRoot}`,
      `File: ${result.relativePath}`,
      '',
      result.description ? `Description: ${result.description}` : '',
      '',
      '---',
      '',
    ]
      .filter(Boolean)
      .join('\n')
    return header + result.body
  },
}
