import { loadAgentRequestedRulesCatalog, loadProjectInstructions } from './project-instructions.ts'
import { getSetting, getSettingTrimmed } from './storage/settings.ts'
import { getAgentExecutionRoot } from './execution-root.ts'
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
  OPUS_5_RESPONSE_LENGTH_BLOCK,
  OPUS_5_TONE_REMINDER,
  PII_REDACTION_BLOCK,
  READ_TERMINAL_BLOCK,
} from './agent-prompt.ts'
import { isOpus5Model } from '@copse/llm/model-catalog.ts'
import { buildSemanticSearchPromptBlock } from './search/semantic-search.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { OKF_MEMORIES_PLUGIN_ID } from '@copse/agent/plugins/okf-memories-plugin.ts'
import { PII_REDACTION_PLUGIN_ID } from '@copse/agent/plugins/pii-redaction-plugin.ts'
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
  /**
   * Model the turn will run on. Only gates the Opus 5 conciseness steering;
   * omit it (headless smoke checks, composer estimates without a pinned model)
   * and the prompt stays model-agnostic.
   */
  model?: string
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
  // Gated on the `copse.okf-memories` plugin — the same enablement
  // `syncOkfMemoryTools` reads to register the remember/recall tools, so the
  // prompt block and the registered tools always agree.
  const okfMemoriesEnabled = getDefaultPluginRegistry().isEnabled(OKF_MEMORIES_PLUGIN_ID)
  // Gated by the `copse.pii-redaction` plugin — the same enablement that registers
  // the reveal_pii tool and arms the input rewrite (`pii-redactor.ts`), so the
  // steering block and the tool never advertise each other out of sync.
  const piiRedactionEnabled = getDefaultPluginRegistry().isEnabled(PII_REDACTION_PLUGIN_ID)
  const readTerminalEnabled =
    getSetting<boolean>(READ_TERMINAL_ENABLED_SETTING, READ_TERMINAL_ENABLED_DEFAULT) &&
    (threadId ? hasTerminalSessions(threadId) : hasTerminalSessions())
  const customInstructions = getSettingTrimmed('customInstructions')
  const opus5 = opts.model != null && isOpus5Model(opts.model)
  return (
    basePrompt
      .replace('{SKILLS_TOOLS_LINE}', skillsToolsLine)
      // Must be the agent execution root, not the renderer workspace root: the
      // sandbox read grant and run_shell's cwd are the worktree root, so naming
      // the main repo here makes the agent `cd` outside the grant and hit EPERM.
      .replace('{WORKSPACE_ROOT}', getAgentExecutionRoot() ?? '(none)') +
    (opus5 ? OPUS_5_RESPONSE_LENGTH_BLOCK : '') +
    (externalApiSafety ? EXTERNAL_API_SAFETY_BLOCK : '') +
    (browserToolsEnabled ? BROWSER_TOOLS_BLOCK : '') +
    (readTerminalEnabled ? READ_TERMINAL_BLOCK : '') +
    (okfMemoriesEnabled ? MEMORY_TOOLS_BLOCK : '') +
    (piiRedactionEnabled ? PII_REDACTION_BLOCK : '') +
    buildSkillsCatalogBlock() +
    (await buildInvokedSkillsBlock(invokedSkills, { sandboxActive: isProjectSandboxActive() })) +
    agentRulesCatalog +
    buildSemanticSearchPromptBlock() +
    (opus5 ? OPUS_5_TONE_REMINDER : '') +
    (customInstructions ? `\n\n---\n\n## Custom instructions\n\n${customInstructions}` : '') +
    (projectInstructions ? `\n\n---\n\n## Project instructions\n\n${projectInstructions}` : '')
  )
}
