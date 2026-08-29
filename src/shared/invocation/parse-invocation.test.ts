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

  it('prefers the longest matching name so a prefix cannot steal it', () => {
    const resolved = resolveInvocation('check /demo-skill now', INVOCABLES)
    assert.equal(resolved?.name, 'demo-skill', '/demo must not match inside /demo-skill')
    assert.equal(resolved.kind, 'skill')
  })

  it('returns null for text with no invocation at all', () => {
    assert.equal(resolveInvocation('just a normal message', INVOCABLES), null)
  })
})

describe('mergeInvocables', () => {
  it('tags each name with what it is', () => {
    assert.deepEqual(mergeInvocables(['a'], ['b']), [
      { name: 'a', kind: 'skill' },
      { name: 'b', kind: 'agent' },
    ])
  })

  it('gives a colliding name to the skill, so no existing /name changes meaning', () => {
    assert.deepEqual(mergeInvocables(['reviewer'], ['reviewer']), [
      { name: 'reviewer', kind: 'skill' },
    ])
  })

  it('de-duplicates within a list', () => {
    assert.deepEqual(mergeInvocables(['a', 'a'], []), [{ name: 'a', kind: 'skill' }])
  })
})
