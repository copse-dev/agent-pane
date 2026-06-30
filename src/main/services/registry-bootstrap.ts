import { ToolRegistry } from './tool-registry.ts'
import { readFileTool, listDirTool } from '../tools/file-tools.ts'
import { searchCodeTool, findFilesTool } from '../tools/search-tools.ts'
import { searchCodebaseTool, semanticSearchTool } from '../tools/search-codebase-tool.ts'
import { gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool } from '../tools/git-tools.ts'
import {
  ghPrFilesTool,
  ghPrListTool,
  ghPrViewTool,
  ghRunListTool,
  ghRunViewTool,
} from '../tools/gh-tools.ts'
import { investigateCiTool } from '../tools/investigate-ci-tool.ts'
import {
  getCiStatusTool,
  waitForCiChecksTool,
  getCiFailureLogsTool,
} from '../tools/github-ci-tools.ts'
import { runShellTool } from '../tools/shell-tool.ts'
import { writeFileTool } from '../tools/write-file-tool.ts'
import { strReplaceTool } from '../tools/str-replace-tool.ts'
import { readStagedDiffTool, stagedDiffsTool } from '../tools/staged-diff-tools.ts'
import { deleteFileTool, renameFileTool, makeDirectoryTool } from '../tools/file-ops-tools.ts'
import { exploreTool } from '../tools/explore-tool.ts'
import { readSkillTool } from '../tools/read-skill-tool.ts'
import { updateTodosTool } from '../tools/todo-tool.ts'
import { askUserTool } from '../tools/ask-user-tool.ts'
import { webSearchTool, fetchUrlTool } from '../tools/web-tools.ts'
import { browserTools } from '../tools/browser-tools.ts'
import { rememberTool, recallTool } from '../tools/memory-tools.ts'
import { revealPiiTool } from '../tools/reveal-pii-tool.ts'
import { PII_REDACTION_ENABLED_SETTING } from './pii-redactor.ts'
import { listSkills } from './skills-registry.ts'
import { getSetting } from './settings.ts'
import { isGhAvailable } from './tool-availability.ts'
import {
  BROWSER_TOOLS_ENABLED_SETTING,
  BROWSER_TOOLS_DEFAULT_ENABLED,
} from './browser/browser-origin-policy.ts'
import { CI_INVESTIGATOR_ENABLED_SETTING } from './ci-investigator-service.ts'
import { OKF_MEMORIES_ENABLED_SETTING } from './okf-memory-store.ts'
import { ROADMAP_PLANS_ENABLED_SETTING } from './roadmap-plans-store.ts'
import { roadmapPlanTool } from '../tools/roadmap-tools.ts'

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(writeFileTool)
  registry.register(strReplaceTool)
  registry.register(stagedDiffsTool)
  registry.register(readStagedDiffTool)
  registry.register(deleteFileTool)
  registry.register(renameFileTool)
  registry.register(makeDirectoryTool)
  registry.register(listDirTool)
  registry.register(searchCodeTool)
  registry.register(findFilesTool)
  registry.register(searchCodebaseTool)
  registry.register(semanticSearchTool)
  registry.register(gitStatusTool)
  registry.register(gitDiffTool)
  registry.register(gitLogTool)
  registry.register(gitCommitTool)
  // GitHub-backed tools shell out to `gh`. Only expose them to the model when
  // we've deterministically probed `gh` as available (checkToolAvailability runs
  // before createRegistry); otherwise every call would just return "gh is not
  // available", so advertising them is misleading. checkToolAvailability also
  // treats a `gh` that can't authenticate as unavailable, keeping read-only GH
  // tools hidden when access is unauthorized.
  const ghAvailable = isGhAvailable()
  if (ghAvailable) {
    registry.register(ghPrListTool)
    registry.register(ghPrViewTool)
    registry.register(ghPrFilesTool)
    registry.register(getCiStatusTool)
    registry.register(waitForCiChecksTool)
    registry.register(getCiFailureLogsTool)
  }
  registry.register(runShellTool)
  registry.register(exploreTool)
  // Experimental CI investigator subagent (off by default). Gates its entry tool
  // and the deep-log gh_run_* helpers it relies on so the feature is fully inert
  // unless explicitly opted into via the experimental setting. Also requires `gh`
  // since the run-log helpers shell out to it.
  if (ghAvailable && getSetting<boolean>(CI_INVESTIGATOR_ENABLED_SETTING, false)) {
    registry.register(ghRunListTool)
    registry.register(ghRunViewTool)
    registry.register(investigateCiTool)
  }
  // Experimental OKF memories (off by default). Adds remember/recall tools that
  // persist project knowledge as Open Knowledge Format notes under ~/.copse.
  syncOkfMemoryTools(registry)
  // Experimental roadmap plans (off by default, issue #556). Adds a roadmap_plan
  // tool that records future-work prompts and tracks their status across
  // sessions so longer-horizon work is captured without being started early.
  if (getSetting<boolean>(ROADMAP_PLANS_ENABLED_SETTING, false)) {
    registry.register(roadmapPlanTool)
  }
  // Experimental PII redaction (off by default). Adds the reveal_pii tool that
  // turns a redacted placeholder back into its real value, gated by user
  // approval. Only registered when redaction is on — otherwise no placeholders
  // exist to reveal.
  syncPiiTools(registry)
  registry.register(webSearchTool)
  registry.register(fetchUrlTool)
  registry.register(updateTodosTool)
  registry.register(askUserTool)
  if (getSetting<boolean>(BROWSER_TOOLS_ENABLED_SETTING, BROWSER_TOOLS_DEFAULT_ENABLED)) {
    for (const tool of browserTools) registry.register(tool)
  }
  return registry
}

/**
 * Register or unregister the experimental OKF memory tools to match the current
 * `okfMemoriesEnabled` setting. Called at startup (via createRegistry) and again
 * whenever the setting is toggled, so the tools appear or disappear live without
 * an app restart. This keeps the registry in sync with the memory system-prompt
 * block, which is rebuilt every turn from the same setting — otherwise enabling
 * the feature mid-session would advertise remember/recall in the prompt while the
 * registry still rejected the calls as "Unknown tool".
 */
export function syncOkfMemoryTools(registry: ToolRegistry): void {
  if (getSetting<boolean>(OKF_MEMORIES_ENABLED_SETTING, false)) {
    if (!registry.has('remember')) registry.register(rememberTool)
    if (!registry.has('recall')) registry.register(recallTool)
  } else {
    registry.unregister('remember')
    registry.unregister('recall')
  }
}

/**
 * Register or unregister the experimental PII reveal tool to match the current
 * `piiRedactionEnabled` setting. Called at startup (via createRegistry) and again
 * whenever the setting is toggled, so the tool appears or disappears live — and
 * stays in sync with the redaction system-prompt block, which is rebuilt every
 * turn from the same setting.
 */
export function syncPiiTools(registry: ToolRegistry): void {
  if (getSetting<boolean>(PII_REDACTION_ENABLED_SETTING, false)) {
    if (!registry.has('reveal_pii')) registry.register(revealPiiTool)
  } else {
    registry.unregister('reveal_pii')
  }
}

/** Register skill tools after the skills registry has been populated. */
export function registerSkillTools(registry: ToolRegistry): void {
  if (!getSetting<boolean>('skillsEnabled', true)) return
  if (listSkills().length === 0) return
  if (!registry.has('read_skill')) registry.register(readSkillTool)
}
