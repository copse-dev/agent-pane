// AGENTS.md compatibility as a first-party instruction-source plugin.
//
// The four modes mirror Claude Code's built-in agents-md mod. This module owns
// the pure source-selection policy; the host instruction engine owns all file
// access, trust, containment, limits, deduplication, and rendering.
import {
  definePlugin,
  type PluginInstructionSourceDecl,
  type RegisteredPlugin,
} from './plugin-manifest.ts'

export const AGENTS_MD_PLUGIN_ID = 'copse.agents-md'
export const AGENTS_MD_INSTRUCTION_SOURCE = 'agents-md'
export const AGENTS_MD_INSTRUCTION_FILES_SETTING_ID = 'instructionFiles'

export const AGENTS_MD_INSTRUCTION_FILE_MODES = [
  'claude-md',
  'claude-md-or-agents-md',
  'claude-md-and-agents-md',
  'managed-only',
] as const

export type AgentsMdInstructionFilesMode = (typeof AGENTS_MD_INSTRUCTION_FILE_MODES)[number]

export const DEFAULT_AGENTS_MD_INSTRUCTION_FILES_MODE: AgentsMdInstructionFilesMode =
  'claude-md-or-agents-md'

/** Copse keeps the historical singular spelling as a root-only compatibility source. */
export const AGENTS_MD_PROJECT_FILES = ['AGENT.md', 'AGENTS.md', '.claude/AGENTS.md'] as const
export const AGENTS_MD_GLOBAL_FILES = ['AGENTS.md'] as const
export const AGENTS_MD_NESTED_FILES = ['AGENTS.md', '.claude/AGENTS.md'] as const

export interface InstructionSourceSelection {
  readonly claudeMd: boolean
  readonly agentsMd: boolean
  /** Managed-only suppresses other workspace-authored rule families too. */
  readonly managedOnly: boolean
  readonly mode: AgentsMdInstructionFilesMode
}

export function normalizeAgentsMdInstructionFilesMode(
  value: unknown,
): AgentsMdInstructionFilesMode {
  switch (value) {
    case 'claude-md':
    case 'claude-md-or-agents-md':
    case 'claude-md-and-agents-md':
    case 'managed-only':
      return value
    default:
      return DEFAULT_AGENTS_MD_INSTRUCTION_FILES_MODE
  }
}

/**
 * Resolve which source families contribute to one context.
 *
 * Turning the AGENTS.md plugin off restores native CLAUDE.md-only behavior.
 * A disabled CLAUDE.md plugin cannot suppress AGENTS.md fallback merely because
 * a dormant CLAUDE.md file happens to exist on disk.
 */
export function resolveInstructionSourceSelection(input: {
  agentsMdPluginEnabled: boolean
  claudeMdPluginEnabled: boolean
  instructionFiles: unknown
  hasProjectClaudeMd: boolean
}): InstructionSourceSelection {
  if (!input.agentsMdPluginEnabled) {
    return {
      claudeMd: input.claudeMdPluginEnabled,
      agentsMd: false,
      managedOnly: false,
      mode: 'claude-md',
    }
  }

  const mode = normalizeAgentsMdInstructionFilesMode(input.instructionFiles)
  switch (mode) {
    case 'claude-md':
      return {
        claudeMd: input.claudeMdPluginEnabled,
        agentsMd: false,
        managedOnly: false,
        mode,
      }
    case 'claude-md-or-agents-md': {
      const claudeMd = input.claudeMdPluginEnabled
      return {
        claudeMd,
        agentsMd: !claudeMd || !input.hasProjectClaudeMd,
        managedOnly: false,
        mode,
      }
    }
    case 'claude-md-and-agents-md':
      return {
        claudeMd: input.claudeMdPluginEnabled,
        agentsMd: true,
        managedOnly: false,
        mode,
      }
    case 'managed-only':
      return { claudeMd: false, agentsMd: false, managedOnly: true, mode }
  }
}

const AGENTS_MD_SOURCE_DECL: PluginInstructionSourceDecl = {
  name: AGENTS_MD_INSTRUCTION_SOURCE,
  title: 'AGENTS.md instructions',
  description:
    'Loads AGENTS.md-family files with Claude-compatible fallback, combined, CLAUDE-only, and managed-only modes.',
}

export const agentsMdPlugin: RegisteredPlugin = definePlugin(
  {
    name: AGENTS_MD_PLUGIN_ID,
    description:
      'AGENTS.md compatibility — reads AGENTS.md like Claude Code reads CLAUDE.md, with a four-mode Project instructions policy.',
    trust: 'first-party',
    stability: 'stable',
    settings: {
      [AGENTS_MD_INSTRUCTION_FILES_SETTING_ID]: {
        kind: 'enum',
        title: 'Project instructions',
        description:
          'Choose CLAUDE.md only, AGENTS.md as fallback, both families together, or managed/system instructions only.',
        default: DEFAULT_AGENTS_MD_INSTRUCTION_FILES_MODE,
        options: AGENTS_MD_INSTRUCTION_FILE_MODES,
      },
    },
  },
  { instructionSources: [AGENTS_MD_SOURCE_DECL] },
)
