import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getModelInfo,
  inferCloudModelProvider,
  isOpus5Model,
  operatorInstructionPlacement,
  TRACKED_MODELS,
} from './model-catalog.ts'
import {
  firstPartyProviderOf,
  modelCapabilities,
  type ModelTransport,
} from './model-capabilities.ts'
import { hasModelIdPrefix, undatedModelId, type ModelFeatures } from './model-families.ts'
import { modelParameterSupport } from './model-parameters.ts'

const FEATURE_KEYS = [
  'supportsStrictTools',
  'supportsVerbosity',
  'supportsParallelToolCallsControl',
  'supportsServerCompaction',
  'prefersApplyPatch',
  'acceptsDeveloperRole',
  'acceptsMidConversationSystem',
] as const satisfies ReadonlyArray<keyof ModelFeatures>

function enabledFeatures(model: string): string[] {
  const caps = modelCapabilities(model)
  return FEATURE_KEYS.filter((key) => caps[key])
}

const GPT_REASONING = [
  'supportsStrictTools',
  'supportsVerbosity',
  'supportsParallelToolCallsControl',
  'supportsServerCompaction',
  'prefersApplyPatch',
  'acceptsDeveloperRole',
]
const O_SERIES = ['supportsStrictTools', 'acceptsDeveloperRole']
const GPT_4O = ['supportsStrictTools', 'supportsParallelToolCallsControl', 'acceptsDeveloperRole']

interface Row {
  id: string
  transport: ModelTransport
  provider: 'anthropic' | 'openai' | null
  family: string | null
  known: boolean
  features: readonly string[]
}

// Every id in TRACKED_MODELS, pinned. Transport and placement here are what the
// `startsWith` routing produced before the capability table existed.
const CATALOG_ROWS: readonly Row[] = [
  ...[
    ['claude-sonnet-5-5', 'claude-sonnet-5', []],
    ['claude-fable-5-1', 'claude-fable-5', ['acceptsMidConversationSystem']],
    ['claude-fable-5', 'claude-fable-5', ['acceptsMidConversationSystem']],
    ['claude-sonnet-5', 'claude-sonnet-5', []],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6', []],
    ['claude-opus-5-5', 'claude-opus-5', ['acceptsMidConversationSystem']],
    ['claude-opus-5', 'claude-opus-5', ['acceptsMidConversationSystem']],
    ['claude-opus-4-8', 'claude-opus-4-8', ['acceptsMidConversationSystem']],
    ['claude-haiku-4-5', 'claude-haiku-4-5', []],
  ].map(([id, family, features]): Row => ({
    id: String(id),
    transport: 'anthropic',
    provider: 'anthropic',
    family: String(family),
    known: true,
    features: Array.isArray(features) ? features : [],
  })),
  ...[
    ['gpt-5.6-sol', 'gpt-5'],
    ['gpt-5.6-terra', 'gpt-5'],
    ['gpt-5.6-luna', 'gpt-5'],
    ['gpt-6.1-sol', 'gpt-6.1-sol'],
    ['gpt-6-astra', 'gpt-6-astra'],
    ['gpt-5.5', 'gpt-5'],
    ['gpt-5', 'gpt-5'],
    ['gpt-5-mini', 'gpt-5'],
    ['gpt-5-nano', 'gpt-5'],
  ].map(([id, family]): Row => ({
    id: String(id),
    transport: 'openai-responses',
    provider: 'openai',
    family: String(family),
    known: true,
    features: GPT_REASONING,
  })),
  ...['gpt-4o', 'gpt-4o-mini'].map((id): Row => ({
    id,
    transport: 'openai-chat',
    provider: 'openai',
    family: 'gpt-4o',
    known: true,
    features: GPT_4O,
  })),
]

describe('modelCapabilities: catalog models', () => {
  it('pins every tracked model', () => {
    assert.deepEqual(
      CATALOG_ROWS.map((row) => row.id).toSorted(),
      [...TRACKED_MODELS].toSorted(),
      'add a row when a model is added to TRACKED_MODELS',
    )
  })

  for (const row of CATALOG_ROWS) {
    it(row.id, () => {
      const caps = modelCapabilities(row.id)
      assert.equal(caps.transport, row.transport)
      assert.equal(caps.provider, row.provider)
      assert.equal(caps.family, row.family)
      assert.equal(caps.known, row.known)
      assert.deepEqual(
        enabledFeatures(row.id),
        FEATURE_KEYS.filter((key) => row.features.includes(key)),
      )
      assert.equal(caps.contextWindow, getModelInfo(row.id)?.contextWindow)
      // Parameters are `modelParameterSupport`, not a second table.
      assert.deepEqual(caps.parameters, modelParameterSupport(row.id))
      assert.equal(inferCloudModelProvider(row.id), row.provider)
    })
  }

  it('keeps the operator-instruction placement each tracked model had', () => {
    for (const row of CATALOG_ROWS) {
      const expected =
        row.provider === 'openai'
          ? 'trailing-developer'
          : row.features.includes('acceptsMidConversationSystem')
            ? 'trailing-system'
            : 'leading-system'
      assert.equal(operatorInstructionPlacement(row.id), expected, row.id)
    }
  })

  it('claims server compaction only for the GPT-5/6 families OpenAI documents it for', () => {
    for (const row of CATALOG_ROWS) {
      assert.equal(
        modelCapabilities(row.id).supportsServerCompaction,
        row.transport === 'openai-responses',
        row.id,
      )
    }
  })

  it('never claims it for the o-series, or for a GPT model reached through a router', () => {
    for (const id of ['o3', 'o4-mini', 'openrouter:openai/gpt-5', 'lmstudio:gpt-5']) {
      assert.equal(modelCapabilities(id).supportsServerCompaction, false, id)
    }
  })
})

interface TrickyRow {
  id: string
  transport: ModelTransport
  provider: 'anthropic' | 'openai' | null
  family: string | null
  known: boolean
  features: readonly string[]
  contextWindow?: number | null
}

const TRICKY_ROWS: readonly TrickyRow[] = [
  // Dated snapshots resolve through the family entry, and through the catalog.
  {
    id: 'gpt-5.6-sol-2026-07-01',
    transport: 'openai-responses',
    provider: 'openai',
    family: 'gpt-5',
    known: true,
    features: GPT_REASONING,
    contextWindow: getModelInfo('gpt-5.6-sol')?.contextWindow ?? null,
  },
  {
    id: 'gpt-5-2025-08-07',
    transport: 'openai-responses',
    provider: 'openai',
    family: 'gpt-5',
    known: true,
    features: GPT_REASONING,
    contextWindow: getModelInfo('gpt-5')?.contextWindow ?? null,
  },
  {
    id: 'gpt-6-astra-2026-09-03',
    transport: 'openai-responses',
    provider: 'openai',
    family: 'gpt-6-astra',
    known: true,
    features: GPT_REASONING,
  },
  {
    id: 'claude-opus-5-20260101',
    transport: 'anthropic',
    provider: 'anthropic',
    family: 'claude-opus-5',
    known: true,
    features: ['acceptsMidConversationSystem'],
  },
  // Non-reasoning OpenAI stays on chat completions.
  {
    id: 'gpt-4o-2024-08-06',
    transport: 'openai-chat',
    provider: 'openai',
    family: 'gpt-4o',
    known: true,
    features: GPT_4O,
  },
  // o-series are first-party OpenAI over Responses, without `text.verbosity`.
  {
    id: 'o1-mini',
    transport: 'openai-responses',
    provider: 'openai',
    family: 'o1',
    known: true,
    features: O_SERIES,
  },
  {
    id: 'o3-2025-04-16',
    transport: 'openai-responses',
    provider: 'openai',
    family: 'o3',
    known: true,
    features: O_SERIES,
  },
  {
    id: 'o4-mini',
    transport: 'openai-responses',
    provider: 'openai',
    family: 'o4',
    known: true,
    features: O_SERIES,
  },
  // A different family that merely starts with the same letters is not claimed.
  {
    id: 'o1x-turbo',
    transport: 'unknown',
    provider: null,
    family: null,
    known: false,
    features: [],
  },
  // gpt-oss is not a first-party API model: it keeps the openai route it always
  // had, but none of GPT-5's features.
  {
    id: 'gpt-oss-120b',
    transport: 'openai-chat',
    provider: 'openai',
    family: 'gpt-oss',
    known: true,
    features: [],
  },
  // Unknown first-party-looking ids still reach the provider whose key is the only
  // place they can go — as unknown models with nothing optional enabled.
  {
    id: 'gpt-7-x',
    transport: 'openai-chat',
    provider: 'openai',
    family: null,
    known: false,
    features: [],
    contextWindow: null,
  },
  {
    id: 'gpt-50',
    transport: 'openai-chat',
    provider: 'openai',
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'gpt-5x',
    transport: 'openai-chat',
    provider: 'openai',
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'gpt-4-turbo',
    transport: 'openai-chat',
    provider: 'openai',
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'gpt-7-x-2026-12-01',
    transport: 'openai-chat',
    provider: 'openai',
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'claude-future-9',
    transport: 'anthropic',
    provider: 'anthropic',
    family: null,
    known: false,
    features: [],
  },
  // An unprefixed id no family claims is routed by whichever cloud key exists.
  { id: 'llama-3', transport: 'unknown', provider: null, family: null, known: false, features: [] },
  { id: '', transport: 'unknown', provider: null, family: null, known: false, features: [] },
  // Namespaced selections are never caught by first-party transport rules. They
  // keep *lineage* flags (how the model behaves) but no API flags (what the
  // route accepts).
  {
    id: 'openrouter:openai/gpt-5',
    transport: 'openai-compatible',
    provider: null,
    family: 'gpt-5',
    known: true,
    features: ['prefersApplyPatch', 'acceptsDeveloperRole'],
    contextWindow: null,
  },
  {
    id: 'openrouter:anthropic/claude-opus-5',
    transport: 'openai-compatible',
    provider: null,
    family: 'claude-opus-5',
    known: true,
    features: ['acceptsMidConversationSystem'],
  },
  {
    id: 'perplexity:gpt-5.6-sol',
    transport: 'openai-compatible',
    provider: null,
    family: 'gpt-5',
    known: true,
    features: ['prefersApplyPatch', 'acceptsDeveloperRole'],
  },
  {
    id: 'openrouter:openai/gpt-7-x',
    transport: 'openai-compatible',
    provider: null,
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'openrouter:deepseek/deepseek-v4-flash',
    transport: 'openai-compatible',
    provider: null,
    family: null,
    known: false,
    features: [],
  },
  // Local weights and agents never inherit a family from their name.
  {
    id: 'lmstudio:gpt-5-clone',
    transport: 'local',
    provider: null,
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'lmstudio:claude-distill',
    transport: 'local',
    provider: null,
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'lmstudio:openai/gpt-oss-20b',
    transport: 'local',
    provider: null,
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'acp:codex#gpt-6-astra',
    transport: 'host-routed',
    provider: null,
    family: null,
    known: false,
    features: [],
  },
  {
    id: 'auto:best-value',
    transport: 'host-routed',
    provider: null,
    family: null,
    known: false,
    features: [],
  },
]

describe('modelCapabilities: tricky ids', () => {
  for (const row of TRICKY_ROWS) {
    it(JSON.stringify(row.id), () => {
      const caps = modelCapabilities(row.id)
      assert.equal(caps.transport, row.transport)
      assert.equal(caps.provider, row.provider)
      assert.equal(caps.family, row.family)
      assert.equal(caps.known, row.known)
      assert.deepEqual(
        enabledFeatures(row.id),
        FEATURE_KEYS.filter((key) => row.features.includes(key)),
      )
      if (row.contextWindow !== undefined) assert.equal(caps.contextWindow, row.contextWindow)
      assert.equal(firstPartyProviderOf(row.id), row.provider)
    })
  }
})

describe('modelCapabilities: unknown models', () => {
  it('enables no optional capability for an id it has not reviewed', () => {
    for (const id of [
      'gpt-7-x',
      'gpt-7-x-2026-12-01',
      'claude-future-9',
      'llama-3',
      'o9-preview',
    ]) {
      const caps = modelCapabilities(id)
      assert.equal(caps.known, false, id)
      assert.deepEqual(enabledFeatures(id), [], id)
    }
  })

  it('only ever offers the safe sampling intersection for an unrecognised bare id', () => {
    assert.deepEqual(modelCapabilities('llama-3').parameters.sampling, ['temperature', 'topP'])
    assert.deepEqual(modelCapabilities('llama-3').parameters.reasoning, [])
  })

  it('gives an unknown gpt id the chat transport, not the Responses API', () => {
    assert.equal(modelCapabilities('gpt-7-x').transport, 'openai-chat')
    assert.equal(modelCapabilities('gpt-7-x').parameters.reasoningWire, 'none')
  })
})

describe('modelCapabilities: behaviour pinned to the pre-table routing', () => {
  it('routes the reasoning families to Responses and leaves the rest on chat', () => {
    for (const id of ['gpt-5', 'gpt-5-mini', 'gpt-5.5', 'gpt-6-astra', 'gpt-6.1-sol', 'o3-mini']) {
      assert.equal(modelCapabilities(id).transport, 'openai-responses', id)
    }
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']) {
      assert.equal(modelCapabilities(id).transport, 'openai-chat', id)
    }
  })

  it('keeps leading-system for ids that used to match the broad gpt- prefix', () => {
    // Deliberate tightening: `developer` is only sent to families we have reviewed.
    // gpt-4-turbo and unknown gpt ids now take the placement that works everywhere.
    assert.equal(operatorInstructionPlacement('gpt-4-turbo'), 'leading-system')
    assert.equal(operatorInstructionPlacement('gpt-7-x'), 'leading-system')
    assert.equal(operatorInstructionPlacement('gpt-oss-120b'), 'leading-system')
  })

  it('still steers Opus 5 through aggregators', () => {
    assert.equal(isOpus5Model('claude-opus-5'), true)
    assert.equal(isOpus5Model('openrouter:anthropic/claude-opus-5:beta'), true)
    assert.equal(isOpus5Model('lmstudio:claude-opus-5'), false)
    assert.equal(isOpus5Model('claude-opus-4-8'), false)
  })

  it('is total and never throws', () => {
    for (const id of ['', ':', 'openrouter:', 'acp:', 'a:b:c', 'GPT-5', ' gpt-5']) {
      assert.doesNotThrow(() => modelCapabilities(id), id)
    }
    // Case and whitespace are not normalised: ids are matched as stored.
    assert.equal(modelCapabilities('GPT-5').provider, null)
    assert.equal(modelCapabilities(' gpt-5').provider, null)
  })
})

describe('id matching helpers', () => {
  it('matches on a boundary, not a bare prefix', () => {
    assert.equal(hasModelIdPrefix('gpt-5', 'gpt-5'), true)
    assert.equal(hasModelIdPrefix('gpt-5-mini', 'gpt-5'), true)
    assert.equal(hasModelIdPrefix('gpt-5.5', 'gpt-5'), true)
    assert.equal(hasModelIdPrefix('claude-opus-5:beta', 'claude-opus-5'), true)
    assert.equal(hasModelIdPrefix('claude-opus-4-8@20260101', 'claude-opus-4-8'), true)
    assert.equal(hasModelIdPrefix('gpt-50', 'gpt-5'), false)
    assert.equal(hasModelIdPrefix('o1x-turbo', 'o1'), false)
  })

  it('strips a trailing date stamp only', () => {
    assert.equal(undatedModelId('gpt-5-2025-08-07'), 'gpt-5')
    assert.equal(undatedModelId('claude-sonnet-4-20250514'), 'claude-sonnet-4')
    assert.equal(undatedModelId('gpt-5.6-sol'), 'gpt-5.6-sol')
    assert.equal(undatedModelId('claude-opus-5-5'), 'claude-opus-5-5')
  })
})
