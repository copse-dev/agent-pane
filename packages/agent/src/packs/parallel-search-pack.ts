import { definePack, type RegisteredPack } from './pack-manifest.ts'

export const PARALLEL_SEARCH_PACK_ID = 'copse.parallel-search'
export const PARALLEL_SEARCH_TOOL_NAME = 'parallel_search'
export const PARALLEL_SEARCH_MODE_SETTING_ID = 'mode'
export const PARALLEL_SEARCH_MODES = ['turbo', 'basic', 'advanced'] as const
export type ParallelSearchMode = (typeof PARALLEL_SEARCH_MODES)[number]
export const DEFAULT_PARALLEL_SEARCH_MODE: ParallelSearchMode = 'basic'

export function resolveParallelSearchMode(value: unknown): ParallelSearchMode {
  if (value === 'turbo' || value === 'advanced') return value
  return DEFAULT_PARALLEL_SEARCH_MODE
}

export const parallelSearchPack: RegisteredPack = definePack(
  {
    name: PARALLEL_SEARCH_PACK_ID,
    description:
      'Parallel Search — sends an objective and focused queries to Parallel’s Search API and returns ranked URLs with token-dense excerpts. Requires a Parallel API key; Zero Data Retention is an account/contract property, not enabled by this pack.',
    trust: 'first-party',
    stability: 'experimental',
    tools: {
      native: [PARALLEL_SEARCH_TOOL_NAME],
      acpTools: [PARALLEL_SEARCH_TOOL_NAME],
    },
    ui: [
      {
        id: 'parallel-search-credentials',
        level: 3,
        slot: 'settings-pack-detail',
        title: 'Parallel credentials',
      },
    ],
    settings: {
      [PARALLEL_SEARCH_MODE_SETTING_ID]: {
        kind: 'enum',
        title: 'Default search mode',
        description:
          'Basic balances quality and latency. Turbo is fastest; Advanced spends more time on harder research.',
        default: DEFAULT_PARALLEL_SEARCH_MODE,
        options: PARALLEL_SEARCH_MODES,
      },
    },
    storage: { namespace: PARALLEL_SEARCH_PACK_ID },
  },
  {
    toolNames: [PARALLEL_SEARCH_TOOL_NAME],
    uiContributions: [
      {
        id: 'parallel-search-credentials',
        level: 3,
        slot: 'settings-pack-detail',
        title: 'Parallel credentials',
      },
    ],
  },
)
