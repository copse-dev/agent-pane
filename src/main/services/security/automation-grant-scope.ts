import { AsyncLocalStorage } from 'node:async_hooks'

interface AutomationGrantScope {
  active: boolean
}

const activeGrantScope = new AsyncLocalStorage<AutomationGrantScope>()

/** Schedule grants apply only inside a dispatcher-verified first scheduled turn. */
export async function runWithAutomationGrantScope<T>(run: () => Promise<T>): Promise<T> {
  const scope: AutomationGrantScope = { active: true }
  try {
    return await activeGrantScope.run(scope, run)
  } finally {
    // Async descendants can outlive the turn. Revoke their inherited scope too.
    scope.active = false
  }
}

export function hasAutomationGrantScope(): boolean {
  return activeGrantScope.getStore()?.active === true
}
