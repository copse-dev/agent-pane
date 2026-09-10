import { browserThreadScope } from '@shared/browser-session.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { getSetting } from '../storage/settings.ts'
import {
  WEB_ALLOWED_ORIGINS_SETTING,
  webAllowedOriginsWithDefaults,
} from '../security/web-origin-policy.ts'

const grants = new Map<string, Set<string>>()

export function currentBrowserScope(): string {
  const context = getThreadExecutionContext()
  return browserThreadScope(context?.projectId ?? null, context?.threadId ?? null)
}

export function browserAllowedOrigins(scope: string): string[] {
  const saved = getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null)
  // An explicitly empty allowlist means no network, rather than restoring defaults.
  return [...(saved ?? webAllowedOriginsWithDefaults(null)), ...(grants.get(scope) ?? [])]
}

export function grantBrowserOrigin(scope: string, origin: string): void {
  let origins = grants.get(scope)
  if (!origins) {
    origins = new Set()
    grants.set(scope, origins)
  }
  origins.add(origin)
}
