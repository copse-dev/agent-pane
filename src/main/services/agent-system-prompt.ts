import { loadAgentRequestedRulesCatalog, loadProjectInstructions } from './project-instructions.ts'
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
} from './skills/skill-prompt.ts'
import { extractContextPathsFromText, type CursorRuleContext } from './skills/cursor-rules.ts'
import {
  BASE_SYSTEM_PROMPT,
  BASE_SYSTEM_PROMPT_DIRECT_READS,
  BROWSER_TOOLS_BLOCK,
  EXTERNAL_API_SAFETY_BLOCK,
  MEMORY_TOOLS_BLOCK,
  PII_REDACTION_BLOCK,
  READ_TERMINAL_BLOCK,
} from './agent-prompt.ts'
import { buildSemanticSearchPromptBlock } from './search/semantic-search.ts'
import { getDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { OKF_MEMORIES_PACK_ID } from '@copse/agent/packs/okf-memories-pack.ts'
import { PII_REDACTION_ENABLED_SETTING } from './security/pii-redactor.ts'
import {
  READ_TERMINAL_ENABLED_DEFAULT,
  READ_TERMINAL_ENABLED_SETTING,
} from '@shared/terminal/read-terminal.ts'
import { hasTerminalSessions } from './exec/terminal-service.ts'
import { isProjectSandboxActive } from '../project-sandbox/state.ts'
import type { UserContent } from '@shared/types'
import { userContentToText } from '@shared/remote-agent-stream.ts'

/** Assemble the system prompt for a run from base prompt + skills + instructions. */
export async function buildSystemPrompt(opts: {
  subagentsEnabled: boolean
  invokedSkills: string[]
  threadId?: string
  /** Current user turn — drives Auto-Attached / Manual Cursor rule selection (#636). */
  userPrompt?: UserContent
}): Promise<string> {
  const { subagentsEnabled, invokedSkills, threadId } = opts
  const skillsToolsLine = buildSkillsToolsPromptLine()
  const userText = opts.userPrompt != null ? userContentToText(opts.userPrompt) : ''
  const cursorRuleContext: CursorRuleContext = {
    contextPaths: extractContextPathsFromText(userText),
    userText,
  }
  const projectInstructions = await loadProjectInstructions({ cursorRuleContext })
  const agentRulesCatalog = await loadAgentRequestedRulesCatalog()

  const basePrompt = subagentsEnabled ? BASE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT_DIRECT_READS
  const externalApiSafety = getSetting<boolean>('externalApiSafety', false)
  const browserToolsEnabled = getSetting<boolean>(
    BROWSER_TOOLS_ENABLED_SETTING,
    BROWSER_TOOLS_DEFAULT_ENABLED,
  )
  // Gated on the `copse.okf-memories` pack — the same enablement
  // `syncOkfMemoryTools` reads to register the remember/recall tools, so the
  // prompt block and the registered tools always agree.
  const okfMemoriesEnabled = getDefaultPackRegistry().isEnabled(OKF_MEMORIES_PACK_ID)
  const piiRedactionEnabled = getSetting<boolean>(PII_REDACTION_ENABLED_SETTING, false)
  const readTerminalEnabled =
    getSetting<boolean>(READ_TERMINAL_ENABLED_SETTING, READ_TERMINAL_ENABLED_DEFAULT) &&
    (threadId ? hasTerminalSessions(threadId) : hasTerminalSessions())
  const customInstructions = getSettingTrimmed('customInstructions')
  return (
    basePrompt
      .replace('{SKILLS_TOOLS_LINE}', skillsToolsLine)
      .replace('{WORKSPACE_ROOT}', getWorkspaceRoot() ?? '(none)') +
    (externalApiSafety ? EXTERNAL_API_SAFETY_BLOCK : '') +
    (browserToolsEnabled ? BROWSER_TOOLS_BLOCK : '') +
    (readTerminalEnabled ? READ_TERMINAL_BLOCK : '') +
    (okfMemoriesEnabled ? MEMORY_TOOLS_BLOCK : '') +
    (piiRedactionEnabled ? PII_REDACTION_BLOCK : '') +
    buildSkillsCatalogBlock() +
    (await buildInvokedSkillsBlock(invokedSkills, { sandboxActive: isProjectSandboxActive() })) +
    agentRulesCatalog +
    buildSemanticSearchPromptBlock() +
    (customInstructions ? `\n\n---\n\n## Custom instructions\n\n${customInstructions}` : '') +
    (projectInstructions ? `\n\n---\n\n## Project instructions\n\n${projectInstructions}` : '')
  )
}
