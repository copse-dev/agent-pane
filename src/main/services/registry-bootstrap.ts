import { ToolRegistry } from './tool-registry.ts'
import { readFileTool, listDirTool } from '../tools/file-tools.ts'
import { searchCodeTool, findFilesTool } from '../tools/search-tools.ts'
import { searchCodebaseTool, semanticSearchTool } from '../tools/search-codebase-tool.ts'
import {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitCommitTool,
} from '../tools/git-tools.ts'
import {
  ghPrFilesTool,
  ghPrListTool,
  ghPrViewTool,
  ghRunListTool,
  ghRunViewTool,
} from '../tools/gh-tools.ts'
import { ghPrActionTools } from '../tools/gh-pr-action-tools.ts'
import { hasGitHubApiToken } from './github/backend/github-token.ts'
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
import { PII_REDACTION_ENABLED_SETTING } from './security/pii-redactor.ts'
import { listSkills } from './skills/skills-registry.ts'
import { getSetting } from './storage/settings.ts'
import { isGhAvailable } from './tool-availability.ts'
import {
  BROWSER_TOOLS_ENABLED_SETTING,
  BROWSER_TOOLS_DEFAULT_ENABLED,
} from './browser/browser-origin-policy.ts'
import { CI_INVESTIGATOR_ENABLED_SETTING } from './github/ci-investigator-service.ts'
import { trackLongTaskTool } from '../tools/long-task-tool.ts'
import { MODEL_CLASSIFIER_ENABLED_SETTING } from './providers/model-classifier.ts'
import { suggestModelTool } from '../tools/model-classifier-tool.ts'
import { ADVISOR_STRATEGY_PACK_ID } from '@copse/agent/packs/advisor-strategy-pack.ts'
import { advisorTool } from '../tools/advisor-tool.ts'
import { ORCHESTRATION_STRATEGY_ENABLED_SETTING } from './orchestration-strategy.ts'
import { delegateStepTool } from '../tools/delegate-step-tool.ts'
import { compareModelsTool } from '../tools/compare-models-tool.ts'
import { getDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { MODEL_COMPARISON_PACK_ID } from '@copse/agent/packs/model-comparison-pack.ts'
import { LONG_HORIZON_TASKS_PACK_ID } from '@copse/agent/packs/long-horizon-tasks-pack.ts'
import { ROADMAP_PLANS_PACK_ID } from '@copse/agent/packs/roadmap-plans-pack.ts'
import { OKF_MEMORIES_PACK_ID } from '@copse/agent/packs/okf-memories-pack.ts'
import { roadmapPlanTool } from '../tools/roadmap-tools.ts'
import { BACKGROUND_TASKS_ENABLED_SETTING } from './exec/background-process.ts'
import { runBackgroundTool } from '../tools/background-process-tool.ts'
import {
  READ_TERMINAL_ENABLED_DEFAULT,
  READ_TERMINAL_ENABLED_SETTING,
} from '@shared/terminal/read-terminal.ts'
import { readTerminalTool } from '../tools/read-terminal-tool.ts'
import { runCheckupTool } from '../tools/checkup-tool.ts'

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
  registry.register(gitShowTool)
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
  // PR lifecycle write tools work through the swappable GitHub backend, so they
  // are available whenever *either* `gh` is usable or an API token is present —
  // not gated on `gh` alone like the read tools above. They mutate GitHub state,
  // so they stay out of the read-only allow-list and go through the approval gate.
  if (ghAvailable || hasGitHubApiToken()) {
    for (const tool of ghPrActionTools) registry.register(tool)
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
  // Experimental OKF memories (off by default). Gated by the
  // `copse.okf-memories` first-party pack — the pack toggle in Settings > Packs
  // is the atomic master switch. Adds remember/recall tools that persist project
  // knowledge as Open Knowledge Format notes under ~/.copse. Live toggles route
  // through {@link syncOkfMemoryTools} on `packs:setEnabled`.
  syncOkfMemoryTools(registry)
  // Experimental long-horizon tasks (off by default, issue #558). Gated by the
  // `copse.long-horizon-tasks` first-party pack — the pack toggle in Settings >
  // Packs is the atomic master switch. Live toggles route through
  // {@link syncLongHorizonTasksTools} on `packs:setEnabled`.
  syncLongHorizonTasksTools(registry)
  // Experimental model classifier (off by default, issue #557). Adds a
  // suggest_model tool that recommends a capability tier for a task so work can
  // be routed to the cheapest model that can handle it. Advisory only.
  if (getSetting<boolean>(MODEL_CLASSIFIER_ENABLED_SETTING, false)) {
    registry.register(suggestModelTool)
  }
  // Experimental client-side advisor strategy (off by default, issue #566). Adds
  // an `advisor` tool that forwards the full transcript + verified repo state to
  // a larger advisor model for strategic guidance, so the executor can run on a
  // cheaper / on-device model. The no-arg call matches Claude's native advisor
  // tool contract; optional question / include_diff params only add context.
  // Gated by the `copse.advisor-strategy` first-party pack — the pack toggle in
  // Settings > Packs is the atomic master switch. Live toggles route through
  // {@link syncAdvisorStrategyTools} on `packs:setEnabled`.
  syncAdvisorStrategyTools(registry)
  // Experimental orchestration strategy (off by default) — the advisor's
  // inverse: the chat model stays the orchestrator and a `delegate_step` tool
  // hands each bounded implementation step to a cheaper/faster worker model
  // running as a subagent, with the parent observing between steps.
  if (getSetting<boolean>(ORCHESTRATION_STRATEGY_ENABLED_SETTING, false)) {
    registry.register(delegateStepTool)
  }
  // Experimental model comparison harness. P5: gated by the
  // `copse.model-comparison` first-party pack — the pack toggle in Settings >
  // Packs is the atomic master switch. Live toggles route through
  // {@link syncModelComparisonTools} on `packs:setEnabled`.
  syncModelComparisonTools(registry)
  // Experimental roadmap plans (off by default, issue #556). Gated by the
  // `copse.roadmap-plans` first-party pack — the pack toggle in Settings > Packs
  // is the atomic master switch (it also gates the renderer's Roadmap pane).
  // Live toggles route through {@link syncRoadmapPlanTools} on `packs:setEnabled`.
  syncRoadmapPlanTools(registry)
  // Experimental background tasks (off by default, issue #691). Lets the agent
  // run a long-lived command (dev server, watcher, build) that stays alive
  // across turns. A task may opt into loopback port binding, which prompts for a
  // per-workspace grant (permission-gate) and escalates the sandbox to allow
  // binding for that process's lifetime; without it the task stays contained.
  if (getSetting<boolean>(BACKGROUND_TASKS_ENABLED_SETTING, false)) {
    registry.register(runBackgroundTool)
  }
  // User Shells → agent read (on by default). The tool is still withheld per
  // turn when no shell is open for the chat thread (see parentTools).
  syncReadTerminalTools(registry)
  // Experimental PII redaction (off by default). Adds the reveal_pii tool that
  // turns a redacted placeholder back into its real value, gated by user
  // approval. Only registered when redaction is on — otherwise no placeholders
  // exist to reveal.
  syncPiiTools(registry)
  registry.register(webSearchTool)
  registry.register(fetchUrlTool)
  registry.register(updateTodosTool)
  registry.register(askUserTool)
  // Always-on setup health check ("doctor"). Read-only — gathers diagnostics and
  // returns a report; the agent proposes any fixes for the user to approve.
  registry.register(runCheckupTool)
  if (getSetting<boolean>(BROWSER_TOOLS_ENABLED_SETTING, BROWSER_TOOLS_DEFAULT_ENABLED)) {
    for (const tool of browserTools) registry.register(tool)
  }
  return registry
}

/**
 * Register or unregister the experimental OKF memory tools to match the current
 * enablement of the `copse.okf-memories` first-party pack. Called at startup
 * (via createRegistry) and again whenever the pack is toggled from Settings >
 * Packs (see `ipc/register-handlers.ts` `packs:setEnabled`), so the tools appear
 * or disappear live without an app restart. This keeps the registry in sync with
 * the memory system-prompt block, which is rebuilt every turn from the same pack
 * enablement (`agent-system-prompt.ts`) — otherwise enabling the feature
 * mid-session would advertise remember/recall in the prompt while the registry
 * still rejected the calls as "Unknown tool".
 */
export function syncOkfMemoryTools(registry: ToolRegistry): void {
  if (getDefaultPackRegistry().isEnabled(OKF_MEMORIES_PACK_ID)) {
    if (!registry.has('remember')) registry.register(rememberTool)
    if (!registry.has('recall')) registry.register(recallTool)
  } else {
    registry.unregister('remember')
    registry.unregister('recall')
  }
}

/**
 * Register or unregister the experimental `roadmap_plan` tool to match the
 * current enablement of the `copse.roadmap-plans` first-party pack (issue #556).
 * Called at startup (via createRegistry) and again whenever the pack is toggled
 * from Settings > Packs (see `ipc/register-handlers.ts` `packs:setEnabled`), so
 * enabling the feature (e.g. to use the Roadmap pane) also gives the agent its
 * tool without an app restart — the atomic pack disable drops the tool from the
 * model tool list in the same flag flip that drops the pack's
 * `activeToolNames()` entry from the Settings pack list.
 */
export function syncRoadmapPlanTools(registry: ToolRegistry): void {
  if (getDefaultPackRegistry().isEnabled(ROADMAP_PLANS_PACK_ID)) {
    if (!registry.has('roadmap_plan')) registry.register(roadmapPlanTool)
  } else {
    registry.unregister('roadmap_plan')
  }
}

/**
 * Register or unregister the experimental `compare_models` tool to match the
 * current enablement of the `copse.model-comparison` first-party pack (P5).
 * Called at startup (via createRegistry) and again whenever the pack is toggled
 * from Settings > Packs (see `ipc/register-handlers.ts` `packs:setEnabled`), so
 * the tool appears or disappears live — the atomic pack disable drops the tool
 * from the model tool list in the same flag flip that (a) skips the
 * auto-on-review trigger in `agent-service.ts` and (b) drops the pack's
 * `activeToolNames()` entry from the Settings pack list.
 */
export function syncModelComparisonTools(registry: ToolRegistry): void {
  if (getDefaultPackRegistry().isEnabled(MODEL_COMPARISON_PACK_ID)) {
    if (!registry.has('compare_models')) registry.register(compareModelsTool)
  } else {
    registry.unregister('compare_models')
  }
}

/**
 * Register or unregister the experimental `track_long_task` tool to match the
 * current enablement of the `copse.long-horizon-tasks` first-party pack (issue
 * #558). Called at startup (via createRegistry) and again whenever the pack is
 * toggled from Settings > Packs (see `ipc/register-handlers.ts`
 * `packs:setEnabled`), so the tool appears or disappears live — the atomic pack
 * disable drops the tool from the model tool list in the same flag flip that
 * drops the pack's `activeToolNames()` entry from the Settings pack list.
 */
export function syncLongHorizonTasksTools(registry: ToolRegistry): void {
  if (getDefaultPackRegistry().isEnabled(LONG_HORIZON_TASKS_PACK_ID)) {
    if (!registry.has('track_long_task')) registry.register(trackLongTaskTool)
  } else {
    registry.unregister('track_long_task')
  }
}

/**
 * Register or unregister the experimental `advisor` tool to match the current
 * enablement of the `copse.advisor-strategy` first-party pack (issue #566).
 * Called at startup (via createRegistry) and again whenever the pack is toggled
 * from Settings > Packs (see `ipc/register-handlers.ts` `packs:setEnabled`), so
 * the tool appears or disappears live — the atomic pack disable drops the tool
 * from the model tool list in the same flag flip that drops the pack's
 * `activeToolNames()` entry from the Settings pack list. The orthogonal
 * `advisorModel` setting (which model the advisor consults) is unaffected.
 */
export function syncAdvisorStrategyTools(registry: ToolRegistry): void {
  if (getDefaultPackRegistry().isEnabled(ADVISOR_STRATEGY_PACK_ID)) {
    if (!registry.has('advisor')) registry.register(advisorTool)
  } else {
    registry.unregister('advisor')
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

/**
 * Register or unregister `read_terminal` to match `readTerminalEnabled`.
 * Default on; the kill switch hides the tool without an app restart. Per-turn
 * availability still requires an open Shells tab for the chat thread.
 */
export function syncReadTerminalTools(registry: ToolRegistry): void {
  if (getSetting<boolean>(READ_TERMINAL_ENABLED_SETTING, READ_TERMINAL_ENABLED_DEFAULT)) {
    if (!registry.has('read_terminal')) registry.register(readTerminalTool)
  } else {
    registry.unregister('read_terminal')
  }
}

/** Register skill tools after the skills registry has been populated. */
export function registerSkillTools(registry: ToolRegistry): void {
  if (!getSetting<boolean>('skillsEnabled', true)) return
  if (listSkills().length === 0) return
  if (!registry.has('read_skill')) registry.register(readSkillTool)
}
