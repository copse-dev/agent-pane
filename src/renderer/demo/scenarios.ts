import { DEMO_SCENARIOS, type DemoScenario } from '@shared/demo-scenarios.ts'

export { DEMO_SCENARIOS, type DemoScenario }

export function selectDemoScenario(search: string): DemoScenario {
  const requested = new URLSearchParams(search).get('scenario')
  const selected = DEMO_SCENARIOS.find((scenario) => scenario.id === requested)
  if (selected) return selected
  const fallback = DEMO_SCENARIOS[0]
  if (!fallback) throw new Error('At least one browser demo scenario is required.')
  return fallback
}
