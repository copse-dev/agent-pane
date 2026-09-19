// Cursor project-rule compatibility as a first-party instruction-source plugin.
// Parsing and secure file access remain host-side; this plugin owns lifecycle.
import {
  definePlugin,
  type PluginInstructionSourceDecl,
  type RegisteredPlugin,
} from './plugin-manifest.ts'

export const CURSOR_RULES_PLUGIN_ID = 'copse.cursor-rules'
export const CURSOR_RULES_INSTRUCTION_SOURCE = 'cursor-rules'

const CURSOR_RULES_SOURCE_DECL: PluginInstructionSourceDecl = {
  name: CURSOR_RULES_INSTRUCTION_SOURCE,
  title: 'Cursor project rules',
  description:
    'Loads applicable .cursor/rules files and exposes agent-requested rules through the hardened instruction engine.',
}

export const cursorRulesPlugin: RegisteredPlugin = definePlugin(
  {
    name: CURSOR_RULES_PLUGIN_ID,
    description:
      'Cursor rules compatibility — supplies .cursor/rules instruction sources while Copse retains trust, containment, and rendering.',
    trust: 'first-party',
    stability: 'stable',
  },
  { instructionSources: [CURSOR_RULES_SOURCE_DECL] },
)
