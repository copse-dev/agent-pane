import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeInvocables,
  parseLeadingInvocation,
  resolveInvocation,
  type Invocable,
} from './parse-invocation.ts'

const INVOCABLES: Invocable[] = [
  { name: 'demo-skill', kind: 'skill' },
  { name: 'ai-writing-signs-report', kind: 'skill' },
  { name: 'reviewer', kind: 'agent' },
  { name: 'demo', kind: 'agent' },
]

describe('parseLeadingInvocation', () => {
  it('splits the name from the rest of the line', () => {
    assert.deepEqual(parseLeadingInvocation('/reviewer look at auth'), {
      name: 'reviewer',
      remainder: 'look at auth',
    })
  })

  it('accepts a bare name with no remainder', () => {
    assert.deepEqual(parseLeadingInvocation('/reviewer'), { name: 'reviewer', remainder: '' })
  })

  it('ignores a slash that does not start the line', () => {
    assert.equal(parseLeadingInvocation('hello /reviewer'), null)
  })
})

describe('resolveInvocation', () => {
  it('reports which kind a leading invocation refers to', () => {
    assert.deepEqual(resolveInvocation('/reviewer look at auth', INVOCABLES), {
      name: 'reviewer',
      remainder: 'look at auth',
      kind: 'agent',
    })
    assert.deepEqual(resolveInvocation('/demo-skill go', INVOCABLES), {
      name: 'demo-skill',
      remainder: 'go',
      kind: 'skill',
    })
  })

  it('returns a null kind for a leading name nobody registered', () => {
    // The caller must be able to tell "typo" from "plain message" — this is the
    // case that used to be reported as an unknown *skill* regardless of intent.
    assert.deepEqual(resolveInvocation('/reviwer look at auth', INVOCABLES), {
      name: 'reviwer',
      remainder: 'look at auth',
      kind: null,
    })
  })

  it('detects an inline mention of a known name', () => {
    assert.deepEqual(resolveInvocation('please run /reviewer on this', INVOCABLES), {
      name: 'reviewer',
      remainder: 'please run on this',
      kind: 'agent',
    })
  })

  it('does not read a file path as an invocation', () => {
    assert.equal(resolveInvocation('open /Users/me/notes.md', INVOCABLES), null)
    assert.equal(resolveInvocation('see src/main/index.ts', INVOCABLES), null)
  })

  it('strips the invocation token, not the same name inside an earlier path', () => {
    const cases: Array<[string, string]> = [
      ['look at src/reviewer and /reviewer it', 'look at src/reviewer and it'],
      ['src/reviewer/x.ts needs /reviewer', 'src/reviewer/x.ts needs'],
      ['/tmp/reviewer then /reviewer', '/tmp/reviewer then'],
    ]
    for (const [text, remainder] of cases) {
      assert.deepEqual(
        resolveInvocation(text, INVOCABLES),
        { name: 'reviewer', kind: 'agent', remainder },
        text,
      )
    }
  })

  it('prefers the longest matching name so a prefix cannot steal it', () => {
    const resolved = resolveInvocation('check /demo-skill now', INVOCABLES)
    assert.equal(resolved?.name, 'demo-skill', '/demo must not match inside /demo-skill')
    assert.equal(resolved.kind, 'skill')
  })

  it('returns null for text with no invocation at all', () => {
    assert.equal(resolveInvocation('just a normal message', INVOCABLES), null)
  })
})

describe('plugin-qualified invocations', () => {
  const invocables = mergeInvocables(
    [
      { name: 'review', plugin: 'acme.tools' },
      { name: 'skill', plugin: 'skill' },
    ],
    ['acme', 'skill'],
  )

  it('parses a qualified command and its multiline arguments', () => {
    assert.deepEqual(parseLeadingInvocation('/acme.tools:review inspect\nauth'), {
      name: 'acme.tools:review',
      remainder: 'inspect\nauth',
    })
  })

  it('resolves leading and inline aliases to the canonical skill name', () => {
    for (const [text, remainder] of [
      ['/acme.tools:review inspect auth', 'inspect auth'],
      ['please /acme.tools:review inspect auth', 'please inspect auth'],
      ['/review inspect auth', 'inspect auth'],
    ]) {
      assert.ok(text !== undefined)
      assert.deepEqual(resolveInvocation(text, invocables), {
        name: 'review',
        kind: 'skill',
        remainder,
      })
    }
    assert.deepEqual(resolveInvocation('/skill:skill', invocables), {
      name: 'skill',
      kind: 'skill',
      remainder: '',
    })
  })

  it('reports unknown qualifications without falling back to a bare name', () => {
    for (const name of ['wrong:review', 'acme.tools:missing', 'skill:missing']) {
      assert.deepEqual(resolveInvocation(`/${name} go`, invocables), {
        name,
        kind: null,
        remainder: 'go',
      })
      assert.equal(resolveInvocation(`please /${name} go`, invocables), null)
    }
  })

  it('does not match a partial qualification or a path', () => {
    for (const token of [
      '/acme.tools:review-more',
      '/acme.tools:review/file',
      '/acme.tools:review:extra',
      '/skill:skill/file',
      '/skill/file',
      '/skill:missing',
    ]) {
      assert.equal(resolveInvocation(`please ${token}`, invocables), null, token)
    }
  })

  it('retains sentence punctuation after bare and qualified inline commands', () => {
    for (const token of ['/review', '/acme.tools:review']) {
      assert.deepEqual(resolveInvocation(`please ${token}.`, invocables), {
        name: 'review',
        kind: 'skill',
        remainder: 'please .',
      })
    }
  })

  it('does not qualify standalone skills or agents', () => {
    const standalone = mergeInvocables([{ name: 'review' }], ['agent'])
    assert.equal(resolveInvocation('/plugin:review', standalone)?.kind, null)
    assert.equal(resolveInvocation('/plugin:agent', standalone)?.kind, null)
  })

  it('preserves plugin identity while retaining skill precedence over agents', () => {
    assert.deepEqual(invocables, [
      { name: 'review', plugin: 'acme.tools', kind: 'skill' },
      { name: 'skill', plugin: 'skill', kind: 'skill' },
      { name: 'acme', kind: 'agent' },
    ])
  })
})

describe('mergeInvocables', () => {
  it('tags each name with what it is', () => {
    assert.deepEqual(mergeInvocables([{ name: 'a' }], ['b']), [
      { name: 'a', kind: 'skill' },
      { name: 'b', kind: 'agent' },
    ])
  })

  it('gives a colliding name to the skill, so no existing /name changes meaning', () => {
    assert.deepEqual(mergeInvocables([{ name: 'reviewer' }], ['reviewer']), [
      { name: 'reviewer', kind: 'skill' },
    ])
  })

  it('de-duplicates within a list', () => {
    assert.deepEqual(mergeInvocables([{ name: 'a' }, { name: 'a' }], []), [
      { name: 'a', kind: 'skill' },
    ])
  })
})
