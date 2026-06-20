import { ToolRegistry } from './tool-registry.ts'
import { readFileTool, listDirTool } from '../tools/file-tools.ts'
import { searchCodeTool, findFilesTool } from '../tools/search-tools.ts'
import {
  createSearchCodebaseTool,
  createSemanticSearchTool,
} from '../tools/search-codebase-tool.ts'
import { gitStatusTool, gitDiffTool, gitLogTool } from '../tools/git-tools.ts'
import { runShellTool } from '../tools/shell-tool.ts'
import { writeFileTool } from '../tools/write-file-tool.ts'
import { strReplaceTool } from '../tools/str-replace-tool.ts'
import { exploreTool } from '../tools/explore-tool.ts'
import { readSkillTool } from '../tools/read-skill-tool.ts'
import { listSkills } from './skills-registry.ts'
import { getSetting } from './settings.ts'

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(writeFileTool)
  registry.register(strReplaceTool)
  registry.register(listDirTool)
  registry.register(searchCodeTool)
  registry.register(findFilesTool)
  registry.register(createSearchCodebaseTool())
  registry.register(createSemanticSearchTool())
  registry.register(gitStatusTool)
  registry.register(gitDiffTool)
  registry.register(gitLogTool)
  registry.register(runShellTool)
  registry.register(exploreTool)
  return registry
}

/** Register skill tools after the skills registry has been populated. */
export function registerSkillTools(registry: ToolRegistry): void {
  if (!getSetting<boolean>('skillsEnabled', true)) return
  if (listSkills().length === 0) return
  if (!registry.has('read_skill')) registry.register(readSkillTool)
}
