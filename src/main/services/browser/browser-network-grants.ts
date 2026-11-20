import { browserThreadScope } from '@shared/browser-session.ts'
import { createHash } from 'node:crypto'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { getExplicitWorkspaceRoot } from '../workspace.ts'
import { getSetting } from '../storage/settings.ts'
import {
  WEB_ALLOWED_ORIGINS_SETTING,
  webAllowedOriginsWithDefaults,
} from '../security/web-origin-policy.ts'

const grants = new Map<string, Set<string>>()

export function currentBrowserScope(): string {
  const context = getThreadExecutionContext()
  if (context) return browserThreadScope(context.projectId, context.threadId)
  const root = getExplicitWorkspaceRoot()
  if (!root) return ''
  // Headless runs have no thread IDs. Keep their persistent browser profiles
  // separate by explicit execution root instead of sharing the default profile.
  const rootId = createHash('sha256').update(root).digest('hex')
  return browserThreadScope(`headless-root:${rootId}`, 'headless')
}

export function browserAllowedOrigins(scope: string): string[] {
  const saved = getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null)
  // An explicitly empty allowlist means no network, rather than restoring defaults.
  return [...(saved ?? webAllowedOriginsWithDefaults(null)), ...(grants.get(scope) ?? [])]
}

/** Explicit origins approved for this browser scope during the current app session. */
export function browserSessionOrigins(scope: string): string[] {
  return [...(grants.get(scope) ?? [])].sort()
}

export function grantBrowserOrigin(scope: string, origin: string): void {
  let origins = grants.get(scope)
  if (!origins) {
    origins = new Set()
    grants.set(scope, origins)
  }
  origins.add(origin)
}
