import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  setDefaultPluginRegistry,
  getDefaultPluginRegistry,
} from '@copse/agent/plugins/default-plugin-registry.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { PII_REDACTION_PLUGIN_ID } from '@copse/agent/plugins/pii-redaction-plugin.ts'
import {
  redactUserContent,
  revealPlaceholder,
  clearThreadRedaction,
  setRampartLoaderForTest,
  loadRampart,
  PII_KEEP_LABELS,
  PII_REDACTION_FAILED_NOTICE,
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
  // Enablement is the `copse.pii-redaction` plugin (Settings > Plugins). A fresh
  // first-party registry has the plugin enabled; install it so `redactUserContent`
  // reads a stable instance we can toggle.
  beforeEach(() => {
    setRampartLoaderForTest(() => Promise.resolve(fakeModule()))
    setDefaultPluginRegistry(createFirstPartyPluginRegistry())
  })

  afterEach(() => {
    setRampartLoaderForTest(null)
    setDefaultPluginRegistry(null)
  })

  it('passes text through unchanged when the feature is disabled', async () => {
    getDefaultPluginRegistry().disable(PII_REDACTION_PLUGIN_ID)
    const text = 'email john@example.com to Jane'
    assert.deepEqual(await redactUserContent('t1', text), { content: text })
  })

  it('replaces detected PII with placeholders in a string', async () => {
    const out = await redactUserContent('t1', 'email john@example.com to Jane')
    assert.deepEqual(out, { content: 'email [PII_1] to [PII_2]' })
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
    assert.deepEqual(out.content, [
      { type: 'text', text: 'ping [PII_1]' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
    ])
  })

  it('keeps placeholders stable for the same value across turns in a thread', async () => {
    const first = await redactUserContent('t1', 'Jane said hi')
    const second = await redactUserContent('t1', 'tell Jane again')
    assert.equal(first.content, '[PII_1] said hi')
    assert.equal(second.content, 'tell [PII_1] again')
  })

  it('isolates redaction maps per thread', async () => {
    await redactUserContent('a', 'Jane')
    await redactUserContent('b', 'john@example.com')
    assert.equal(revealPlaceholder('a', '[PII_1]'), 'Jane')
    // Thread b minted its own [PII_1] from a different guard instance.
    assert.equal(revealPlaceholder('b', '[PII_1]'), 'john@example.com')
  })

  it('fails open with a user-facing notice when Rampart is unavailable', async () => {
    setRampartLoaderForTest(() => Promise.resolve(null))
    const text = 'email john@example.com'
    assert.deepEqual(await redactUserContent('t1', text), {
      content: text,
      notice: PII_REDACTION_FAILED_NOTICE,
    })
  })

  it('fails open with a notice when no guard can be created', async () => {
    setRampartLoaderForTest(() =>
      Promise.resolve({ createGuard: () => Promise.reject(new Error('no guard')) }),
    )
    const text = 'email john@example.com'
    assert.deepEqual(await redactUserContent('t1', text), {
      content: text,
      notice: PII_REDACTION_FAILED_NOTICE,
    })
  })

  it('fails open with a notice when scrubbing throws', async () => {
    const throwing: PiiGuard = {
      protect: () => Promise.reject(new Error('scrub failed')),
      reveal: (reply) => reply,
    }
    setRampartLoaderForTest(() => Promise.resolve({ createGuard: () => Promise.resolve(throwing) }))
    const text = 'email john@example.com'
    assert.deepEqual(await redactUserContent('t1', text), {
      content: text,
      notice: PII_REDACTION_FAILED_NOTICE,
    })
  })

  it('does not show a notice when only the contextual model is unavailable', async () => {
    const calls: (boolean | undefined)[] = []
    setRampartLoaderForTest(() =>
      Promise.resolve({
        createGuard: (options) => {
          calls.push(options?.heuristicsOnly)
          return options?.heuristicsOnly === true
            ? Promise.resolve(makeFakeGuard())
            : Promise.reject(new Error('model unavailable'))
        },
      }),
    )
    assert.deepEqual(await redactUserContent('t1', 'ping Jane'), { content: 'ping [PII_1]' })
    assert.deepEqual(calls, [undefined, true])
  })

  it('passes the Copse keep-list and session-tagged aliases to every guard', async () => {
    const seen: Parameters<RampartModule['createGuard']>[0][] = []
    setRampartLoaderForTest(() =>
      Promise.resolve({
        createGuard: (options) => {
          seen.push(options)
          return Promise.resolve(makeFakeGuard())
        },
      }),
    )
    await redactUserContent('a', 'Jane')
    await redactUserContent('b', 'Jane')
    assert.equal(seen.length, 2)
    const [first, second] = seen
    assert.ok(first && second)
    assert.deepEqual(first.keepLabels, PII_KEEP_LABELS)
    assert.deepEqual(second.keepLabels, PII_KEEP_LABELS)
    const firstEmail = first.aliases?.EMAIL ?? ''
    const secondEmail = second.aliases?.EMAIL ?? ''
    assert.match(firstEmail, /^EMAIL_[A-Z]{5}$/)
    assert.match(secondEmail, /^EMAIL_[A-Z]{5}$/)
    // One tag per guard, shared by every label that guard mints.
    const tag = firstEmail.slice('EMAIL_'.length)
    assert.deepEqual(
      [first.aliases?.GIVEN_NAME, first.aliases?.PHONE],
      [`GIVEN_NAME_${tag}`, `PHONE_${tag}`],
    )
  })

  it('clearThreadRedaction drops the thread map so reveal no longer resolves', async () => {
    await redactUserContent('t1', 'Jane')
    assert.equal(revealPlaceholder('t1', '[PII_1]'), 'Jane')
    clearThreadRedaction('t1')
    assert.equal(revealPlaceholder('t1', '[PII_1]'), null)
  })
})

// The same entry points against the real, installed Rampart package (an optional
// dependency; these skip when it is absent). The contextual model is never
// loaded here: the "release" guard runs Rampart's heuristics only — what a
// packaged Copse release does — and the "contextual" guard swaps the ONNX
// classifier for a deterministic detector, so no model is downloaded.
describe('pii-redactor with the real Rampart', () => {
  /** Rampart's `Span`, as its contextual detector reports it. */
  interface ContextualSpan {
    readonly start: number
    readonly end: number
    readonly label: 'PHONE' | 'GIVEN_NAME'
    readonly score: number
    readonly source: 'ner'
    readonly text: string
  }

  const CONTEXTUAL_RULES: readonly { label: ContextualSpan['label']; pattern: RegExp }[] = [
    { label: 'PHONE', pattern: /\+?\d[\d ()-]{8,}\d/g },
    { label: 'GIVEN_NAME', pattern: /\bJane\b/g },
  ]

  function contextualDetector(text: string): Promise<ContextualSpan[]> {
    const spans: ContextualSpan[] = []
    for (const { label, pattern } of CONTEXTUAL_RULES) {
      for (const match of text.matchAll(pattern)) {
        const start = match.index
        const end = start + match[0].length
        spans.push({ start, end, label, score: 0.99, source: 'ner', text: match[0] })
      }
    }
    return Promise.resolve(spans)
  }

  let rampart: RampartModule | null = null

  function useRealRampart(mode: 'release' | 'contextual'): void {
    const real = rampart
    assert.ok(real)
    setRampartLoaderForTest(() =>
      Promise.resolve({
        createGuard: (options) => {
          // A named binding: Copse's option type describes only what production
          // passes, and the detector is Rampart's own `ner` option.
          const withDetector =
            mode === 'release'
              ? { ...options, heuristicsOnly: true }
              : { ...options, ner: contextualDetector }
          return real.createGuard(withDetector)
        },
      }),
    )
  }

  beforeEach(async () => {
    rampart = await loadRampart()
    setDefaultPluginRegistry(createFirstPartyPluginRegistry())
  })

  afterEach(() => {
    setRampartLoaderForTest(null)
    setDefaultPluginRegistry(null)
  })

  async function redactText(threadId: string, text: string): Promise<string> {
    const result = await redactUserContent(threadId, text)
    assert.equal(result.notice, undefined)
    assert.equal(typeof result.content, 'string')
    return typeof result.content === 'string' ? result.content : ''
  }

  it('keeps URLs, hosts, IPs, version numbers and MACs but redacts emails and SSNs', async (t) => {
    if (!rampart) {
      t.skip('@nationaldesignstudio/rampart is not installed')
      return
    }
    useRealRampart('release')
    const kept = [
      'https://github.com/copse-dev/agent-pane/pull/3080',
      'www.example.com/docs',
      '127.0.0.1:5173',
      '1.2.3.4',
      '00:1A:2B:3C:4D:5E',
      'fe80::1',
    ]
    const input = `Open ${kept.join(' and ')}. ` + 'Mail jane.doe@example.com, SSN 123-45-6789.'
    const out = await redactText('t1', input)
    for (const value of kept) assert.ok(out.includes(value), `${value} should be kept in: ${out}`)
    assert.doesNotMatch(out, /jane\.doe@example\.com/)
    assert.doesNotMatch(out, /123-45-6789/)
    const email = /\[EMAIL_[A-Z]{5}_1\]/.exec(out)?.[0]
    assert.ok(email, out)
    assert.match(out, /\[SSN_[A-Z]{5}_1\]/)
    assert.equal(revealPlaceholder('t1', email), 'jane.doe@example.com')
  })

  it('redacts phone numbers and names when the contextual layer reports them', async (t) => {
    if (!rampart) {
      t.skip('@nationaldesignstudio/rampart is not installed')
      return
    }
    useRealRampart('contextual')
    const out = await redactText('t1', 'Call Jane on +1 415 555 0132 about http://localhost:3000')
    assert.doesNotMatch(out, /415 555 0132/)
    assert.doesNotMatch(out, /Jane/)
    assert.match(out, /\[PHONE_[A-Z]{5}_1\]/)
    assert.match(out, /\[GIVEN_NAME_[A-Z]{5}_1\]/)
    assert.ok(out.includes('http://localhost:3000'), out)
  })

  it('never resolves a placeholder from before a restart to a newer value', async (t) => {
    if (!rampart) {
      t.skip('@nationaldesignstudio/rampart is not installed')
      return
    }
    useRealRampart('release')
    const before = await redactText('t1', 'mail first@example.com')
    const oldToken = /\[EMAIL_[A-Z]{5}_1\]/.exec(before)?.[0]
    assert.ok(oldToken, before)

    // A fresh loader drops every in-memory guard, exactly as an app restart does.
    useRealRampart('release')
    const after = await redactText('t1', 'mail second@example.com')
    const newToken = /\[EMAIL_[A-Z]{5}_1\]/.exec(after)?.[0]
    assert.ok(newToken, after)

    assert.notEqual(newToken, oldToken)
    assert.equal(revealPlaceholder('t1', oldToken), null)
    assert.equal(revealPlaceholder('t1', newToken), 'second@example.com')
  })
})
