export type CloudModelProvider = 'anthropic' | 'openai'

/** Per-million-token USD rates: [input, output]. */
export type CloudModelRates = readonly [inputPerM: number, outputPerM: number]

export interface CloudModelDefinition {
  id: string
  label: string
  provider: CloudModelProvider
  contextWindow: number
  rates: CloudModelRates
  /** Anthropic API max_tokens when set for this model. */
  anthropicMaxOutputTokens?: number
}

export const CLOUD_MODELS: readonly CloudModelDefinition[] = [
  {
    id: 'claude-sonnet-4-6',
    label: 'claude-sonnet-4-6',
    provider: 'anthropic',
    contextWindow: 200_000,
    rates: [3.0, 15.0],
    anthropicMaxOutputTokens: 64_000,
  },
  {
    id: 'claude-opus-4-8',
    label: 'claude-opus-4-8',
    provider: 'anthropic',
    contextWindow: 200_000,
    rates: [15.0, 75.0],
    anthropicMaxOutputTokens: 64_000,
  },
  {
    id: 'gpt-4o',
    label: 'gpt-4o',
    provider: 'openai',
    contextWindow: 128_000,
    rates: [2.5, 10.0],
  },
  {
    id: 'gpt-4o-mini',
    label: 'gpt-4o-mini',
    provider: 'openai',
    contextWindow: 128_000,
    rates: [0.15, 0.6],
  },
] as const

const byId = new Map(CLOUD_MODELS.map((m) => [m.id, m]))

export function getCloudModel(id: string): CloudModelDefinition | undefined {
  return byId.get(id)
}

export function cloudModelContextWindow(id: string): number | undefined {
  return byId.get(id)?.contextWindow
}

export function cloudModelRates(id: string): CloudModelRates | undefined {
  return byId.get(id)?.rates
}

const DEFAULT_ANTHROPIC_MAX_OUTPUT = 8192

export function anthropicMaxOutputTokens(model: string): number {
  return byId.get(model)?.anthropicMaxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT
}
