import { loadProjectInstructions } from './project-instructions.ts'
import { getSetting } from './settings.ts'
import { getWorkspaceRoot } from './workspace.ts'
import {
  buildInvokedSkillsBlock,
  buildSkillsCatalogBlock,
  buildSkillsToolsPromptLine,
} from './skill-prompt.ts'
import {
  BASE_SYSTEM_PROMPT,
  BASE_SYSTEM_PROMPT_DIRECT_READS,
  EXTERNAL_API_SAFETY_BLOCK,
} from './agent-prompt.ts'
import { buildSemanticSearchPromptBlock } from './semantic-search.ts'

/** Assemble the system prompt for a run from base prompt + skills + instructions. */
export async function buildSystemPrompt(opts: {
  subagentsEnabled: boolean
  invokedSkills: string[]
}): Promise<string> {
  const { subagentsEnabled, invokedSkills } = opts
  const skillsToolsLine = buildSkillsToolsPromptLine()
  const projectInstructions = await loadProjectInstructions()

  const basePrompt = subagentsEnabled ? BASE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT_DIRECT_READS
  const externalApiSafety = getSetting<boolean>('externalApiSafety', false)
  const customInstructions = getSetting<string>('customInstructions', '').trim()
  return (
    basePrompt
      .replace('{SKILLS_TOOLS_LINE}', skillsToolsLine)
      .replace('{WORKSPACE_ROOT}', getWorkspaceRoot() ?? '(none)') +
    (externalApiSafety ? EXTERNAL_API_SAFETY_BLOCK : '') +
    buildSkillsCatalogBlock() +
    (await buildInvokedSkillsBlock(invokedSkills)) +
    buildSemanticSearchPromptBlock() +
    (customInstructions ? `\n\n---\n\n## Custom instructions\n\n${customInstructions}` : '') +
    (projectInstructions ? `\n\n---\n\n## Project instructions\n\n${projectInstructions}` : '')
  )
}
