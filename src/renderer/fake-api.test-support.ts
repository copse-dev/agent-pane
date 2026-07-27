import type { ApiClient } from '../preload/api.d.ts'
import { createDemoApi } from './demo/demo-api.ts'
import type { DemoScenario } from './demo/scenarios.ts'

/**
 * A **complete** `ApiClient` double for renderer tests.
 *
 * Views and controllers take the whole preload surface, so a hand-rolled
 * object literal can only reach it through an `as unknown as ApiClient` cast —
 * which silently rots the moment the surface changes. The browser demo already
 * implements every member for real (`createDemoApi` type-checks against
 * `ApiClient` with no assertion), so tests build on that and spread their own
 * stubs over the handful of calls they care about:
 *
 * ```ts
 * const base = createFakeApi()
 * const api: ApiClient = { ...base, agent: { ...base.agent, run: record } }
 * ```
 *
 * Test-only: nothing in the app's build graph imports this.
 */

const EMPTY_SCENARIO: DemoScenario = {
  id: 'test',
  label: 'Test',
  project: { id: 'project-1', path: '/workspace', name: 'workspace' },
  threads: [],
  settings: {},
}

export function createFakeApi(): ApiClient {
  return createDemoApi(EMPTY_SCENARIO)
}

/** Complete API proxy whose unoverridden methods stay pending for synchronous mount tests. */
export function createPendingApi(
  overrides: Readonly<Record<string, (...args: unknown[]) => unknown>> = {},
): ApiClient {
  const wrap = <T extends object>(target: T, path: string): T =>
    new Proxy(target, {
      get(object, property, receiver): unknown {
        const nextPath = path ? `${path}.${String(property)}` : String(property)
        const override = overrides[nextPath]
        if (override !== undefined) return override
        const value: unknown = Reflect.get(object, property, receiver)
        if (typeof value === 'function') return () => new Promise(() => {})
        return typeof value === 'object' && value !== null ? wrap(value, nextPath) : value
      },
    })
  return wrap(createFakeApi(), '')
}
