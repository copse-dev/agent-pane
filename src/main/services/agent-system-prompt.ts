import {
  loadAgentRequestedRulesCatalog,
  loadInstructionLayersWithMetadata,
  type InstructionLayerMetadata,
} from './project-instructions.ts'
import { getSetting, getSettingTrimmed } from './storage/settings.ts'
import { getAgentExecutionRoot } from './execution-root.ts'
import { getThreadExecutionContext } from './thread-execution-context.ts'
import { repositoryLocation } from './worktree-manager.ts'
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
  EXTERNAL_CONTENT_BLOCK,
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

/**
 * State the Git repository root next to the working directory, from the turn's
 * trusted execution context (#1724). A thread whose tools run in a linked
 * worktree must be told which tree is its repository — an agent that guesses
 * from a shell's inherited cwd can edit, test, and commit against the project's
 * shared checkout instead. Resolved only when a turn context is bound: composer
 * estimates and other off-turn builds skip the Git probe and emit nothing.
 */
async function buildRepositoryContext(): Promise<string> {
  const context = getThreadExecutionContext()
  if (!context) return ''
  let repositoryRoot: string
  let projectRelativePath: string
  try {
    ;({ repositoryRoot, projectRelativePath } = await repositoryLocation(context.root))
  } catch {
    // Not a Git checkout, or Git is unavailable (e.g. a remote project root):
    // the working-directory line stands alone rather than failing the turn.
    return ''
  }
  if (context.checkoutMode === 'worktree') {
    // No branch name here: it can be adopted mid-thread, and naming it would
    // invalidate the cached prompt prefix on every adoption (#1286). The path
    // is the stable, authoritative fact.
    return (
      `\nGit repository root: ${repositoryRoot} — this thread's own linked Git worktree. ` +
      "All file, git, and shell tools resolve against this worktree, not the project's shared checkout. " +
      'If a path or Git result looks inconsistent, verify with `git rev-parse --show-toplevel` before acting on it.'
    )
  }
  const subdirNote = projectRelativePath
    ? ' (the working directory is a subdirectory of this repository)'
    : ''
  return `\nGit repository root: ${repositoryRoot}${subdirNote}`
}

export interface BuildSystemPromptOptions {
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
  /** Persist nested-source activation for Settings; real local turns set this. */
  trackInstructionActivation?: boolean
}

export interface SystemPromptBuildResult {
  prompt: string
  instructionMetadata: InstructionLayerMetadata
}

/** Assemble the system prompt and retain nested-instruction runtime metadata. */
export async function buildSystemPromptWithMetadata(
  opts: BuildSystemPromptOptions,
): Promise<SystemPromptBuildResult> {
  const { subagentsEnabled, invokedSkills, threadId } = opts
  const skillsToolsLine = buildSkillsToolsPromptLine()
  const userText = opts.userPrompt != null ? userContentToText(opts.userPrompt) : ''
  const contextPaths = extractContextPathsFromText(userText)
  const cursorRuleContext: CursorRuleContext = {
    contextPaths,
    userText,
  }
  const instructionLayers = await loadInstructionLayersWithMetadata(
    { cursorRuleContext, nestedContextPaths: contextPaths },
    opts.trackInstructionActivation ?? false,
  )
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
  const prompt =
    basePrompt
      .replace('{SKILLS_TOOLS_LINE}', skillsToolsLine)
      // Must be the agent execution root, not the renderer workspace root: the
      // sandbox read grant and run_shell's cwd are the worktree root, so naming
      // the main repo here makes the agent `cd` outside the grant and hit EPERM.
      .replace('{WORKSPACE_ROOT}', getAgentExecutionRoot() ?? '(none)')
      .replace('{REPO_CONTEXT}', await buildRepositoryContext()) +
    (opus5 ? OPUS_5_RESPONSE_LENGTH_BLOCK : '') +
    // Workspace-authored instructions sit here — above every Copse-authored
    // steering block instead of terminal, so workspace text is never the
    // closing word of the prompt (context-provenance plan, Phase 2). The
    // user-global layer keeps the old end-of-prompt position below.
    (instructionLayers.project ? `\n\n---\n\n${instructionLayers.project}` : '') +
    (externalApiSafety ? EXTERNAL_API_SAFETY_BLOCK : '') +
    EXTERNAL_CONTENT_BLOCK +
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
    (instructionLayers.global
      ? `\n\n---\n\n## User instructions\n\n${instructionLayers.global}`
      : '')
  return { prompt, instructionMetadata: instructionLayers.metadata }
}

/** Prompt-only compatibility wrapper for estimates, tests, and other callers. */
export async function buildSystemPrompt(opts: BuildSystemPromptOptions): Promise<string> {
  return (await buildSystemPromptWithMetadata(opts)).prompt
}
