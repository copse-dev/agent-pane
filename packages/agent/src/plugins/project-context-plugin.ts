import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

export const PROJECT_CONTEXT_PLUGIN_ID = 'copse.project-context'
export const PROJECT_CONTEXT_TOOL_NAMES = ['search_project_context', 'read_project_context']

/** Explicit, bounded retrieval from this project's saved conversations and memories. */
export const projectContextPlugin: RegisteredPlugin = definePlugin(
  {
    name: PROJECT_CONTEXT_PLUGIN_ID,
    description:
      'Lets agents search saved conversations and enabled memories in the current project, then read selected sources. Reading other conversations requires your permission.',
    trust: 'first-party',
    stability: 'experimental',
    tools: { native: PROJECT_CONTEXT_TOOL_NAMES },
  },
  { toolNames: PROJECT_CONTEXT_TOOL_NAMES },
)
