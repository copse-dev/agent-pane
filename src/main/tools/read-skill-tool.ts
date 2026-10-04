import { z } from 'zod'
import { defineTool } from '@shared/types'
import { getSkill, readSkill } from '../services/skills/skills-registry.ts'
import { getSkillActivationTurn } from '../services/skills/skill-activation.ts'

export const readSkillTool = defineTool({
  name: 'read_skill',
  description:
    'Activate a relevant model-invocable skill by reading SKILL.md (omit path), before following its instructions. ' +
    'Then read supporting files under its directory (scripts/, references/, assets/). ' +
    'Reads from the skill install path outside the workspace sandbox and auto-runs without approval. ' +
    'Use name (e.g. "demo-skill") and optional path relative to the skill root — not an absolute filesystem path. ' +
    'Activation is attributed in this tool result, is bounded and deduplicated per turn, and grants no permissions. ' +
    'Explicit /skill-name instructions are already injected; do not reload them.',
  parameters: z.object({
    name: z.string().describe('Skill name from frontmatter, e.g. "demo-skill"'),
    path: z
      .string()
      .optional()
      .describe('Optional path relative to the skill root. Defaults to SKILL.md'),
  }),
  async execute({ name, path }, signal) {
    const activation = getSkillActivationTurn()
    if (activation) return activation.read(name, path, signal)
    // A runner that does not own an activation budget must not silently bypass it.
    // Resolve unknown names first to retain the registry's useful diagnostics.
    if (!getSkill(name)) await readSkill(name, path ?? 'SKILL.md')
    throw new Error(
      'Model skill activation is unavailable in this runner. Use explicit /skill-name invocation in a supported native parent turn.',
    )
  },
})
