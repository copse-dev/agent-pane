// Native CLAUDE.md compatibility as a first-party instruction-source plugin.
//
// This module owns source-specific policy only: the names and precedence of
// CLAUDE.md-family files. The host instruction engine owns filesystem access,
// workspace trust, containment, caps, deduplication, and prompt rendering.
import {
  definePlugin,
  type PluginInstructionSourceDecl,
  type RegisteredPlugin,
} from './plugin-manifest.ts'

export const CLAUDE_MD_PLUGIN_ID = 'copse.claude-md'
export const CLAUDE_MD_INSTRUCTION_SOURCE = 'claude-md'

/** User-global files, relative to the profile home. */
export const CLAUDE_MD_GLOBAL_FILES = ['.claude/CLAUDE.md'] as const

/** Files at the project root, in native Claude precedence order. */
export const CLAUDE_MD_PROJECT_FILES = [
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  'CLAUDE.local.md',
] as const

/** Files checked in a referenced subdirectory. */
export const CLAUDE_MD_NESTED_FILES = CLAUDE_MD_PROJECT_FILES

const CLAUDE_MD_SOURCE_DECL: PluginInstructionSourceDecl = {
  name: CLAUDE_MD_INSTRUCTION_SOURCE,
  title: 'CLAUDE.md instructions',
  description:
    'Loads user, project, local, and nested CLAUDE.md-family instruction files through the hardened instruction engine.',
}

export const claudeMdPlugin: RegisteredPlugin = definePlugin(
  {
    name: CLAUDE_MD_PLUGIN_ID,
    description:
      'CLAUDE.md compatibility — supplies native Claude project-instruction sources while Copse retains trust, containment, and prompt rendering.',
    trust: 'first-party',
    stability: 'stable',
  },
  { instructionSources: [CLAUDE_MD_SOURCE_DECL] },
)
