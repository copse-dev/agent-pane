import { COMPUTER_USE_TOOL_NAMES } from '@copse/agent/plugins/computer-use-plugin.ts'
import { desktopAppApproval } from '@shared/approval-copy.ts'
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
 * a plain approval lasts for the thread, or for one call outside a thread.
 * Blocked apps throw before any prompt. A tool-level allow policy does not
 * skip this gate: it would otherwise grant every app at once.
 */

const DESKTOP_CONTROL_TOOLS: ReadonlySet<string> = new Set(COMPUTER_USE_TOOL_NAMES)
const UNGATED_DESKTOP_TOOLS = new Set(['desktop_apps'])

/** Thread id → bundle ids approved for that thread without "always allow". */
const threadGrants = new Map<string, Set<string>>()

export function isDesktopControlTool(toolName: string): boolean {
  return DESKTOP_CONTROL_TOOLS.has(toolName)
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
  const threadId = getThreadExecutionContext()?.threadId
  const decision = decideDesktopAppAccess({
    bundleId,
    allowedBundleIds: getSetting<string[]>(DESKTOP_ALLOWED_APPS_SETTING, []),
    sessionBundleIds: threadId ? threadGrants.get(threadId) : undefined,
  })
  if (decision.action === 'deny') {
    throw new Error(`Computer use cannot touch this app: ${decision.reason}.`)
  }
  if (decision.action === 'allow' && explicitPolicy !== 'ask') return true

  const prompt = desktopAppApproval({
    bundleId,
    action: describeAction(toolName, record),
    caution: decision.action === 'prompt' ? decision.caution : undefined,
    allowRemember: explicitPolicy !== 'ask',
    threadScoped: threadId !== undefined,
  })
  const { approved, remember } = await requestApproval(
    {
      ...prompt,
      type: 'mcp',
      cause: 'desktop-app-control',
      subject: bundleId,
      scope: 'external',
    },
    signal,
  )
  if (!approved) return false
  if (remember && prompt.allowRemember) {
    await updateSetting<string[]>(DESKTOP_ALLOWED_APPS_SETTING, [], (saved) =>
      saved.includes(bundleId) ? saved : [...saved, bundleId],
    )
  } else if (threadId) {
    const grants = threadGrants.get(threadId) ?? new Set<string>()
    grants.add(bundleId)
    threadGrants.set(threadId, grants)
  }
  return true
}

/** Forget thread-scoped grants; saved "always allow" entries are untouched. */
export function clearDesktopThreadGrants(): void {
  threadGrants.clear()
}
