import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import {
  redactUserContent,
  revealPlaceholder,
  clearThreadRedaction,
  setRampartLoaderForTest,
  PII_REDACTION_ENABLED_SETTING,
  type RampartModule,
  type PiiGuard,
} from './pii-redactor.ts'

// A deterministic stand-in for a Rampart ChatGuard: a per-conversation table that
// maps a fixed set of "detected" values to stable, reusable placeholders.
function makeFakeGuard(): PiiGuard {
  const forward = new Map<string, string>()
  const reverse = new Map<string, string>()
  let n = 0
  const known = [/john@example\.com/g, /Jane/g]
  return {
    protect(text): Promise<{ text: string; placeholders: readonly string[] }> {
      let out = text
      for (const re of known) {
        out = out.replace(re, (match) => {
          let token = forward.get(match)
          if (!token) {
            token = `[PII_${String(++n)}]`
            forward.set(match, token)
            reverse.set(token, match)
          }
          return token
        })
      }
      return Promise.resolve({ text: out, placeholders: [...reverse.keys()] })
    },
    reveal(reply): string {
      let out = reply
      for (const [token, value] of reverse) out = out.split(token).join(value)
      return out
    },
  }
}

// A fresh guard per createGuard call, so different threads stay isolated.
function fakeModule(): RampartModule {
  return { createGuard: () => Promise.resolve(makeFakeGuard()) }
}

describe('pii-redactor', () => {
  beforeEach(async () => {
    setRampartLoaderForTest(() => Promise.resolve(fakeModule()))
    await setSetting(PII_REDACTION_ENABLED_SETTING, true)
  })

  afterEach(async () => {
    setRampartLoaderForTest(null)
    await setSetting(PII_REDACTION_ENABLED_SETTING, false)
  })

  it('passes text through unchanged when the feature is disabled', async () => {
    await setSetting(PII_REDACTION_ENABLED_SETTING, false)
    const text = 'email john@example.com to Jane'
    assert.equal(await redactUserContent('t1', text), text)
  })

  it('replaces detected PII with placeholders in a string', async () => {
    const out = await redactUserContent('t1', 'email john@example.com to Jane')
    assert.equal(out, 'email [PII_1] to [PII_2]')
  })

  it('reveals a known placeholder and returns null for an unknown one', async () => {
    await redactUserContent('t1', 'email john@example.com')
    assert.equal(revealPlaceholder('t1', '[PII_1]'), 'john@example.com')
    assert.equal(revealPlaceholder('t1', '[PII_9]'), null)
    assert.equal(revealPlaceholder('unknown-thread', '[PII_1]'), null)
  })

  it('redacts text blocks but leaves image blocks untouched', async () => {
    const out = await redactUserContent('t1', [
      { type: 'text', text: 'ping Jane' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
    ])
    assert.deepEqual(out, [
      { type: 'text', text: 'ping [PII_1]' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
    ])
  })

  it('keeps placeholders stable for the same value across turns in a thread', async () => {
    const first = await redactUserContent('t1', 'Jane said hi')
    const second = await redactUserContent('t1', 'tell Jane again')
    assert.equal(first, '[PII_1] said hi')
    assert.equal(second, 'tell [PII_1] again')
  })

  it('isolates redaction maps per thread', async () => {
    await redactUserContent('a', 'Jane')
    await redactUserContent('b', 'john@example.com')
    assert.equal(revealPlaceholder('a', '[PII_1]'), 'Jane')
    // Thread b minted its own [PII_1] from a different guard instance.
    assert.equal(revealPlaceholder('b', '[PII_1]'), 'john@example.com')
  })

  it('fails open (sends text unchanged) when Rampart is unavailable', async () => {
    setRampartLoaderForTest(() => Promise.resolve(null))
    const text = 'email john@example.com'
    assert.equal(await redactUserContent('t1', text), text)
  })

  it('clearThreadRedaction drops the thread map so reveal no longer resolves', async () => {
    await redactUserContent('t1', 'Jane')
    assert.equal(revealPlaceholder('t1', '[PII_1]'), 'Jane')
    clearThreadRedaction('t1')
    assert.equal(revealPlaceholder('t1', '[PII_1]'), null)
  })
})
