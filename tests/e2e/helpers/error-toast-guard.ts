import { isIgnorableAfterTestError, withTimeout } from './after-test-safety.ts'

/** A real product error cannot become an ignorable transport error because of its text. */
export class UnexpectedErrorToastsError extends Error {
  constructor(toasts: readonly string[], context?: string) {
    const prefix = context ? `${context}: ` : ''
    super(`${prefix}Unexpected error toast(s): ${toasts.join(' | ')}`)
    this.name = 'UnexpectedErrorToastsError'
  }
}

interface ErrorToastHookContext {
  currentTest?: { title: string; state?: string; err?: unknown }
}

interface SessionSafeguards {
  budgetMs: number
  killWedgedSession: () => void
}

type Observation = { kind: 'checked' | 'ignored' } | { kind: 'failed'; error: unknown }

/** WDIO afterTest can observe faults, but only a real Mocha hook can fail the suite. */
export function createErrorToastGuard(
  check: (context: string) => Promise<void>,
  safeguards?: SessionSafeguards,
): {
  recordAfterTest: (runnable: object | undefined, title: string, passed: boolean) => Promise<void>
  afterEach: (this: ErrorToastHookContext) => Promise<void>
} {
  const observations = new WeakMap<object, Observation>()
  let missingRunnable: Error | undefined
  const fail = (error: unknown): never => {
    // The pinned adapter omits root-hook reporter events; retain the actual reason in CI logs.
    console.error('E2E error-toast guard failed', error)
    throw error
  }

  const checkSession = async (title: string): Promise<'checked' | 'ignored'> => {
    try {
      if (safeguards) {
        await withTimeout(check(title), safeguards.budgetMs, 'afterTest toast assertion')
      } else {
        // Real-agent eval previously had neither a toast timeout nor transport exemptions.
        await check(title)
      }
      return 'checked'
    } catch (error) {
      if (
        !safeguards ||
        error instanceof UnexpectedErrorToastsError ||
        !isIgnorableAfterTestError(error)
      ) {
        throw error
      }
      safeguards.killWedgedSession()
      return 'ignored'
    }
  }

  return {
    async recordAfterTest(runnable, title, passed): Promise<void> {
      if (!passed) return
      if (!runnable) {
        missingRunnable = new Error('The toast guard could not identify the Mocha runnable')
        return
      }
      // A later transport death must never erase an already observed application fault.
      if (observations.get(runnable)?.kind === 'failed') return
      try {
        observations.set(runnable, { kind: await checkSession(title) })
      } catch (error) {
        observations.set(runnable, { kind: 'failed', error })
      }
    },
    async afterEach(): Promise<void> {
      const test = this.currentTest
      const observation = test ? observations.get(test) : undefined
      if (test) observations.delete(test)
      const identityError = missingRunnable
      missingRunnable = undefined
      if (observation?.kind === 'failed') fail(observation.error)
      // Keep the original body/cleanup failure and avoid its possibly-dead session.
      if (test?.state === 'failed' || (test?.err !== undefined && test.err !== null)) return
      if (identityError) fail(identityError)
      if (observation?.kind === 'ignored') return
      // This also checks cleanup errors and enforces when Mocha supplies no state.
      try {
        await checkSession(test?.title ?? 'e2e test')
      } catch (error) {
        fail(error)
      }
    },
  }
}
