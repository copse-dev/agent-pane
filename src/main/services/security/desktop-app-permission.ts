import { isRecord } from '@shared/unknown-value.ts'
import { requestApproval } from '../approval.ts'
import { getSetting, updateSetting } from '../storage/settings.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import {
  DESKTOP_ALLOWED_APPS_SETTING,
  decideDesktopAppAccess,
} from '../desktop-control/desktop-app-policy.ts'

/**
 * The per-app gate for the computer-use `desktop_*` tools.
 *
 * Listing apps needs no approval. Every other tool names one app by bundle id,
 * and the first use of that app in a thread asks — reading an app's window is
 * already access to whatever it shows. "Always allow" persists the bundle id;
 * a plain approval lasts for the thread. Blocked apps throw before any prompt.
 */

export const DESKTOP_CONTROL_TOOL_PREFIX = 'desktop_'
const UNGATED_DESKTOP_TOOLS = new Set(['desktop_apps'])

/** Thread id → bundle ids approved for that thread without "always allow". */
const threadGrants = new Map<string, Set<string>>()

export function isDesktopControlTool(toolName: string): boolean {
  return toolName.startsWith(DESKTOP_CONTROL_TOOL_PREFIX)
}

function threadKey(): string {
  return getThreadExecutionContext()?.threadId ?? 'no-thread'
}

function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'desktop_snapshot':
      return 'read its window contents'
    case 'desktop_screenshot':
      return 'take a screenshot of its window'
    case 'desktop_click':
      return typeof args['ref'] === 'string'
        ? `activate element ${args['ref']}`
        : 'click in its window'
    case 'desktop_type':
      return 'type text into it'
    case 'desktop_key':
      return 'press keys in it'
    case 'desktop_menu':
      return Array.isArray(args['path'])
        ? `choose ${args['path'].filter((part) => typeof part === 'string').join(' > ')}`
        : 'choose a menu item'
    default:
      return 'operate it'
  }
}

export async function checkDesktopAppPermission(
  toolName: string,
  args: unknown,
  signal?: AbortSignal,
  explicitPolicy?: 'allow' | 'ask',
): Promise<boolean> {
  if (UNGATED_DESKTOP_TOOLS.has(toolName)) return true
  const record = isRecord(args) ? args : {}
  const bundleId = typeof record['app'] === 'string' ? record['app'] : ''
  const key = threadKey()
  const decision = decideDesktopAppAccess({
    bundleId,
    allowedBundleIds: getSetting<string[]>(DESKTOP_ALLOWED_APPS_SETTING, []),
    sessionBundleIds: threadGrants.get(key),
  })
  if (decision.action === 'deny') {
    throw new Error(`Computer use cannot touch this app: ${decision.reason}.`)
  }
  if (explicitPolicy === 'allow') return true
  if (decision.action === 'allow' && explicitPolicy !== 'ask') return true

  const action = describeAction(toolName, record)
  const { approved, remember } = await requestApproval(
    {
      title: `Let the agent use ${bundleId}?`,
      body: [
        `The agent wants to ${action}.`,
        '',
        'It works in the background through Accessibility and can see anything this app shows, including signed-in accounts. Text it reads from the app is treated as untrusted.',
      ].join('\n'),
      type: 'mcp',
      cause: 'desktop-app-control',
      subject: bundleId,
      scope: 'external',
      approveLabel: 'Allow for this thread',
      allowRemember: explicitPolicy !== 'ask',
      rememberLabel: `Always allow ${bundleId}`,
    },
    signal,
  )
  if (!approved) return false
  if (remember && explicitPolicy !== 'ask') {
    await updateSetting<string[]>(DESKTOP_ALLOWED_APPS_SETTING, [], (saved) =>
      saved.includes(bundleId) ? saved : [...saved, bundleId],
    )
  } else {
    const grants = threadGrants.get(key) ?? new Set<string>()
    grants.add(bundleId)
    threadGrants.set(key, grants)
  }
  return true
}

/** Forget thread-scoped grants; saved "always allow" entries are untouched. */
export function clearDesktopThreadGrants(): void {
  threadGrants.clear()
}
