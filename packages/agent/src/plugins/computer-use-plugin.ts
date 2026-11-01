import { definePlugin, type RegisteredPlugin } from './plugin-manifest.ts'

export const COMPUTER_USE_PLUGIN_ID = 'copse.computer-use'
export const COMPUTER_USE_TOOL_NAMES = [
  'desktop_apps',
  'desktop_snapshot',
  'desktop_screenshot',
  'desktop_click',
  'desktop_type',
  'desktop_key',
  'desktop_menu',
] as const

/**
 * Computer use operates other macOS apps through a native helper that holds its
 * own Accessibility and Screen Recording grants. It is first-party because the
 * helper and the per-app permission gate live in the main process, and
 * experimental so it ships disabled: every tool reads or drives apps outside
 * the project sandbox.
 */
export const computerUsePlugin: RegisteredPlugin = definePlugin(
  {
    name: COMPUTER_USE_PLUGIN_ID,
    description:
      'Let agents see and operate the Mac apps you approve, in the background, through Accessibility. Terminals, password managers, and Copse itself are never available.',
    trust: 'first-party',
    stability: 'experimental',
    tools: {
      native: [...COMPUTER_USE_TOOL_NAMES],
      acpTools: [...COMPUTER_USE_TOOL_NAMES],
    },
  },
  { toolNames: [...COMPUTER_USE_TOOL_NAMES] },
)
