export const WEB_SEARCH_PROVIDERS = ['none', 'tavily', 'parallel'] as const
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number]

export const WEB_SEARCH_ENDPOINTS = {
  tavily: 'https://api.tavily.com/search',
  parallel: 'https://api.parallel.ai/v1/search',
}

export const WEB_SEARCH_LABELS = {
  none: 'Not configured',
  tavily: 'Tavily',
  parallel: 'Parallel',
}

export function resolveWebSearchProvider(value: unknown): WebSearchProvider {
  return value === 'tavily' || value === 'parallel' ? value : 'none'
}
