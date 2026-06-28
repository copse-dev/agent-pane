import { ToolRegistry } from './tool-registry.ts'
import { readFileTool, listDirTool } from '../tools/file-tools.ts'
import { searchCodeTool, findFilesTool } from '../tools/search-tools.ts'
import {
  createSearchCodebaseTool,
  createSemanticSearchTool,
} from '../tools/search-codebase-tool.ts'
import { gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool } from '../tools/git-tools.ts'
import { ghPrListTool, ghPrViewTool, ghRunListTool, ghRunViewTool } from '../tools/gh-tools.ts'
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
import { webSearchTool, fetchUrlTool } from '../tools/web-tools.ts'
import { browserTools } from '../tools/browser-tools.ts'
import { listSkills } from './skills-registry.ts'
import { getSetting } from './settings.ts'
import {
  BROWSER_TOOLS_ENABLED_SETTING,
  BROWSER_TOOLS_DEFAULT_ENABLED,
} from './browser/browser-origin-policy.ts'
import { CI_INVESTIGATOR_ENABLED_SETTING } from './ci-investigator-service.ts'

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
  registry.register(createSearchCodebaseTool())
  registry.register(createSemanticSearchTool())
  registry.register(gitStatusTool)
  registry.register(gitDiffTool)
  registry.register(gitLogTool)
  registry.register(gitCommitTool)
  registry.register(ghPrListTool)
  registry.register(ghPrViewTool)
  registry.register(getCiStatusTool)
  registry.register(waitForCiChecksTool)
  registry.register(getCiFailureLogsTool)
  registry.register(runShellTool)
  registry.register(exploreTool)
  // Experimental CI investigator subagent (off by default). Gates its entry tool
  // and the deep-log gh_run_* helpers it relies on so the feature is fully inert
  // unless explicitly opted into via the experimental setting.
  if (getSetting<boolean>(CI_INVESTIGATOR_ENABLED_SETTING, false)) {
    registry.register(ghRunListTool)
    registry.register(ghRunViewTool)
    registry.register(investigateCiTool)
  }
  registry.register(webSearchTool)
  registry.register(fetchUrlTool)
  registry.register(updateTodosTool)
  if (getSetting<boolean>(BROWSER_TOOLS_ENABLED_SETTING, BROWSER_TOOLS_DEFAULT_ENABLED)) {
    for (const tool of browserTools) registry.register(tool)
  }
  return registry
}

/** Register skill tools after the skills registry has been populated. */
export function registerSkillTools(registry: ToolRegistry): void {
  if (!getSetting<boolean>('skillsEnabled', true)) return
  if (listSkills().length === 0) return
  if (!registry.has('read_skill')) registry.register(readSkillTool)
}
