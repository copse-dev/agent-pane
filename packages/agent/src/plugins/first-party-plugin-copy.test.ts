import assert from 'node:assert/strict'
import { it } from 'node:test'
import { FIRST_PARTY_PLUGINS } from './first-party-plugins.ts'

it('describes built-in packs without exposing internal tool identifiers', () => {
  for (const plugin of FIRST_PARTY_PLUGINS) {
    const descriptions = [
      plugin.manifest.description,
      ...Object.values(plugin.manifest.settings ?? {}).map((setting) => setting.description),
      ...(plugin.manifest.capabilities ?? []).map((capability) => capability.description),
    ]
    for (const description of descriptions) {
      assert.doesNotMatch(description ?? '', /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/u, plugin.id)
    }
  }
})
