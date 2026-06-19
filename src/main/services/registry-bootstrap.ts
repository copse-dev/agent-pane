import { ToolRegistry } from './tool-registry.ts'
import { readFileTool, listDirTool } from '../tools/file-tools.ts'
import { searchCodeTool, findFilesTool } from '../tools/search-tools.ts'
import { gitStatusTool, gitDiffTool, gitLogTool } from '../tools/git-tools.ts'
import { runShellTool } from '../tools/shell-tool.ts'
import { writeFileTool } from '../tools/write-file-tool.ts'
import { readSkillTool } from '../tools/read-skill-tool.ts'
import { listSkills } from './skills-registry.ts'
import { getSetting } from './settings.ts'

export function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  if (getSetting<boolean>('skillsEnabled', true) && listSkills().length > 0) {
    registry.register(readSkillTool)
  }
  registry.register(writeFileTool)
  registry.register(listDirTool)
  registry.register(searchCodeTool)
  registry.register(findFilesTool)
  registry.register(gitStatusTool)
  registry.register(gitDiffTool)
  registry.register(gitLogTool)
  registry.register(runShellTool)
  return registry
}
