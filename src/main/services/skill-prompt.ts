import { listSkills, readSkill } from './skills-registry.ts'
import { splitSkillMarkdown } from './parse-skill-frontmatter.ts'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function skillMarkdownBody(raw: string): string {
  const split = splitSkillMarkdown(raw)
  return split?.body ?? raw
}

/** Extra tool line for the system prompt when skills are discovered (omitted otherwise). */
export function buildSkillsToolsPromptLine(): string {
  if (listSkills().length === 0) return ''
  return (
    '- read_skill: Read additional files under a skill directory (scripts/, references/, assets/) — ' +
    'auto-runs; reads outside the workspace sandbox. Pass skill name + optional relative path, not absolute paths.\n'
  )
}

/** Tier 1 — skill catalog (name, description, path) without full instructions. */
export function buildSkillsCatalogBlock(): string {
  const skills = listSkills()
  if (skills.length === 0) return ''

  const entries = skills
    .map(
      (skill) =>
        `<agent_skill fullPath="${escapeXml(skill.skillPath)}">${escapeXml(skill.description)}</agent_skill>`,
    )
    .join('\n')

  return (
    `\n\n---\n\n<available_skills>\n${entries}\n</available_skills>\n\n` +
    `Skills are invoked manually via /skill-name in the input. When a skill is invoked, ` +
    `its full instructions are injected below. Use read_skill (not read_file or run_shell) with ` +
    `skill name + optional relative path for additional files under a skill directory.`
  )
}

/** Tier 2 — full SKILL.md instructions for manually invoked skills. */
export async function buildInvokedSkillsBlock(invokedSkills: string[]): Promise<string> {
  if (invokedSkills.length === 0) return ''

  const sections: string[] = []
  for (const name of invokedSkills) {
    try {
      const skill = await readSkill(name)
      const body = skillMarkdownBody(skill.body)
      sections.push(
        [
          `<skill_content name="${escapeXml(name)}">`,
          `Skill directory: ${skill.skillRoot}`,
          'Relative paths in this skill are relative to the skill directory.',
          '',
          body,
          '</skill_content>',
        ].join('\n'),
      )
    } catch {
      sections.push(
        `<skill_content name="${escapeXml(name)}">(failed to load skill)</skill_content>`,
      )
    }
  }

  return (
    `\n\n---\n\n## Invoked skills\n\n` +
    `The user explicitly invoked these skills for this turn. Treat each invoked skill as the ` +
    `primary task for this turn — follow its instructions even when prior conversation ` +
    `context suggests a different task. Use read_skill (not read_file or run_shell) with skill ` +
    `name + optional relative path when you need files under scripts/, references/, or assets/.\n\n` +
    sections.join('\n\n')
  )
}
