import { loadProjectInstructions } from './project-instructions.ts'
import { getSetting, getSettingTrimmed } from './storage/settings.ts'
import { getWorkspaceRoot } from './workspace.ts'
import {
  BROWSER_TOOLS_ENABLED_SETTING,
  BROWSER_TOOLS_DEFAULT_ENABLED,
} from './browser/browser-origin-policy.ts'
import {
  buildInvokedSkillsBlock,
  buildSkillsCatalogBlock,
  buildSkillsToolsPromptLine,
} from './skill-prompt.ts'
import {
  BASE_SYSTEM_PROMPT,
  BASE_SYSTEM_PROMPT_DIRECT_READS,
  BROWSER_TOOLS_BLOCK,
  EXTERNAL_API_SAFETY_BLOCK,
  MEMORY_TOOLS_BLOCK,
  PII_REDACTION_BLOCK,
} from './agent-prompt.ts'
import { buildSemanticSearchPromptBlock } from './search/semantic-search.ts'
import { OKF_MEMORIES_ENABLED_SETTING } from '../tools/memory-tools.ts'
import { PII_REDACTION_ENABLED_SETTING } from './security/pii-redactor.ts'
import { isProjectSandboxActive } from '../project-sandbox/state.ts'

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
  const browserToolsEnabled = getSetting<boolean>(
    BROWSER_TOOLS_ENABLED_SETTING,
    BROWSER_TOOLS_DEFAULT_ENABLED,
  )
  const okfMemoriesEnabled = getSetting<boolean>(OKF_MEMORIES_ENABLED_SETTING, false)
  const piiRedactionEnabled = getSetting<boolean>(PII_REDACTION_ENABLED_SETTING, false)
  const customInstructions = getSettingTrimmed('customInstructions')
  return (
    basePrompt
      .replace('{SKILLS_TOOLS_LINE}', skillsToolsLine)
      .replace('{WORKSPACE_ROOT}', getWorkspaceRoot() ?? '(none)') +
    (externalApiSafety ? EXTERNAL_API_SAFETY_BLOCK : '') +
    (browserToolsEnabled ? BROWSER_TOOLS_BLOCK : '') +
    (okfMemoriesEnabled ? MEMORY_TOOLS_BLOCK : '') +
    (piiRedactionEnabled ? PII_REDACTION_BLOCK : '') +
    buildSkillsCatalogBlock() +
    (await buildInvokedSkillsBlock(invokedSkills, { sandboxActive: isProjectSandboxActive() })) +
    buildSemanticSearchPromptBlock() +
    (customInstructions ? `\n\n---\n\n## Custom instructions\n\n${customInstructions}` : '') +
    (projectInstructions ? `\n\n---\n\n## Project instructions\n\n${projectInstructions}` : '')
  )
}
