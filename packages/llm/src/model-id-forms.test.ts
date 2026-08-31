import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelIdForm } from './model-id-forms.ts'

/** A `direct` that recognises a fixed catalog, like every real caller's table probe. */
function catalog(...known: string[]): (candidate: string) => string | null {
  const table = new Set(known)
  return (candidate) => (table.has(candidate) ? candidate : null)
}

describe('resolveModelIdForm', () => {
  it('returns an id the table already knows', () => {
    assert.equal(resolveModelIdForm('gpt-5', catalog('gpt-5')), 'gpt-5')
  })

  it('returns null when nothing resolves', () => {
    assert.equal(resolveModelIdForm('unknown-model', catalog('gpt-5')), null)
  })

  it('peels an option suffix', () => {
    const known = catalog('claude-fable-5')
    assert.equal(resolveModelIdForm('claude-fable-5[1m]', known), 'claude-fable-5')
  })

  it('peels an ACP agent segment', () => {
    const known = catalog('anthropic/claude-sonnet-4.5')
    assert.equal(
      resolveModelIdForm('acp:claude-code#anthropic/claude-sonnet-4.5', known),
      'anthropic/claude-sonnet-4.5',
    )
  })

  it('peels a provider prefix', () => {
    const known = catalog('qwen/qwen3-235b')
    assert.equal(resolveModelIdForm('openrouter:qwen/qwen3-235b', known), 'qwen/qwen3-235b')
  })

  it('peels a serving-route tag from a vendor path', () => {
    const known = catalog('MiniMaxAI/MiniMax-M3')
    assert.equal(resolveModelIdForm('MiniMaxAI/MiniMax-M3:novita', known), 'MiniMaxAI/MiniMax-M3')
  })

  it('never trims a bare word after a colon into a model name', () => {
    assert.equal(resolveModelIdForm('lmstudio:qwen3', catalog('lmstudio')), null)
  })

  it('never fuzzy-matches the model name itself', () => {
    assert.equal(resolveModelIdForm('gpt-5-mini', catalog('gpt-5')), null)
  })

  it('resolves an id carrying every wrapper at once', () => {
    const known = catalog('MiniMaxAI/MiniMax-M3')
    assert.equal(
      resolveModelIdForm('acp:agent#openrouter:MiniMaxAI/MiniMax-M3:novita[1m]', known),
      'MiniMaxAI/MiniMax-M3',
    )
  })

  it('stays cheap on an id that makes the search fan out', () => {
    // Each `a/b` segment satisfies both colon rules, so the unmemoized search
    // explored every interleaving of them: 24 segments cost 16.7M calls / 1.9s.
    // 40 segments would not finish at all, so the probe budget below aborts the
    // search — a regression fails here in milliseconds instead of hanging.
    const id = Array.from({ length: 40 }, () => 'a/b').join(':')
    const budget = 100_000
    let probes = 0
    const counting = (candidate: string): string | null => {
      probes += 1
      if (probes > budget)
        throw new Error(`search did not converge within ${String(budget)} probes`)
      return candidate === 'nothing-matches' ? candidate : null
    }
    assert.equal(resolveModelIdForm(id, counting), null)
    assert.ok(probes < 1_000, `expected a bounded search, probed ${String(probes)} candidates`)
  })

  it('agrees with the unmemoized search on random ids', () => {
    // Deterministic PRNG so a failure is reproducible from the seed alone.
    let seed = 0x1f2e3d4
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const alphabet = ['a', 'b', 'x', '-', '/', ':', '#', '[', ']']
    const known = catalog('a', 'b', 'x', 'ab', 'a/b', 'a:b', 'a/b:x')
    for (let trial = 0; trial < 2_000; trial += 1) {
      let id = ''
      const length = 1 + Math.floor(next() * 12)
      for (let i = 0; i < length; i += 1) {
        id += alphabet[Math.floor(next() * alphabet.length)] ?? 'a'
      }
      assert.equal(
        resolveModelIdForm(id, known),
        referenceResolveModelIdForm(id, known),
        `id=${JSON.stringify(id)}`,
      )
    }
  })
})

/**
 * The plain recursion `resolveModelIdForm` used before it memoized exhausted
 * candidates. Kept here as the oracle proving the memo changed only the cost.
 */
function referenceResolveModelIdForm(
  id: string,
  direct: (candidate: string) => string | null,
): string | null {
  const hit = direct(id)
  if (hit !== null) return hit
  const unbracketed = id.replace(/\[[^\]]*\]$/, '')
  if (unbracketed !== id) return referenceResolveModelIdForm(unbracketed, direct)
  const hash = id.lastIndexOf('#')
  if (hash >= 0) return referenceResolveModelIdForm(id.slice(hash + 1), direct)
  const sep = id.indexOf(':')
  if (sep > 0) {
    const stripped = referenceResolveModelIdForm(id.slice(sep + 1), direct)
    if (stripped !== null) return stripped
  }
  const lastColon = id.lastIndexOf(':')
  if (lastColon > 0 && id.slice(0, lastColon).includes('/')) {
    return referenceResolveModelIdForm(id.slice(0, lastColon), direct)
  }
  return null
}
