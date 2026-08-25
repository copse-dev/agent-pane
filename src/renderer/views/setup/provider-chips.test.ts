import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CHIP_ORDER, LOCAL_CHIP_ORDER } from './custom-providers-section.ts'
import { BUILTIN_EXTRA_PROVIDERS } from '@copse/llm/extra-providers.ts'

// The Settings chips are a hand-ordered design decision, but their MEMBERSHIP
// must track the catalog: a preset added to provider-metadata.json that is in
// neither list would pass the whole suite and still be unreachable in the UI.
describe('provider chip lists track the catalog', () => {
  it('gives every catalog preset a chip in the matching panel', () => {
    for (const provider of BUILTIN_EXTRA_PROVIDERS) {
      const list = provider.local ? LOCAL_CHIP_ORDER : CHIP_ORDER
      assert.ok(
        list.includes(provider.id),
        `preset '${provider.id}' has no ${provider.local ? 'local' : 'cloud'} chip — ` +
          'add it to the order list in custom-providers-section.ts',
      )
    }
  })

  it('lists no chip for a preset that does not exist', () => {
    const ids = new Set(BUILTIN_EXTRA_PROVIDERS.map((provider) => provider.id))
    // CHIP_ORDER also fronts the fixed cloud providers; those are not catalog
    // presets and are allowed.
    const fixed = new Set(['anthropic', 'openai', 'openrouter'])
    for (const slug of [...CHIP_ORDER, ...LOCAL_CHIP_ORDER]) {
      assert.ok(ids.has(slug) || fixed.has(slug), `chip '${slug}' matches no preset`)
    }
  })
})
