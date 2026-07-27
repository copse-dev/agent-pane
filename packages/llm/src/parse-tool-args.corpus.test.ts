// Replays the streamed tool-argument JSON corpus (#752) through parseToolArgs.
// Providers accumulate argument JSON across stream deltas; the corpus pins how
// truncated / dialect-flavored payloads must fail loudly instead of running a
// tool with empty args (#114). See docs/plans/industry-benchmarks.md, Phase 1.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseToolArgs } from './parse-tool-args.ts'

interface ArgsCase {
  id: string
  rawJson: string | null
  expect: { args?: unknown; errorIncludes?: string }
}

const corpusPath = join(process.cwd(), 'tests/fixtures/tool-args-json-corpus.json')
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCorpus(value: unknown): { cases: ArgsCase[] } {
  assert.ok(isRecord(value) && Array.isArray(value['cases']))
  const cases: ArgsCase[] = value['cases'].map((entry: unknown) => {
    assert.ok(isRecord(entry))
    const { id, rawJson, expect } = entry
    assert.ok(
      typeof id === 'string' &&
        (typeof rawJson === 'string' || rawJson === null) &&
        isRecord(expect),
    )
    return { id, rawJson, expect }
  })
  return { cases }
}

const corpus = parseCorpus(JSON.parse(readFileSync(corpusPath, 'utf8')) as unknown)

describe('tool-args JSON corpus: parseToolArgs', () => {
  for (const c of corpus.cases) {
    it(c.id, () => {
      const { args, error } = parseToolArgs(c.rawJson)
      if (c.expect.errorIncludes !== undefined) {
        assert.ok(error?.includes(c.expect.errorIncludes), `error was: ${String(error)}`)
        assert.deepEqual(args, {})
      } else {
        assert.equal(error, undefined)
        assert.deepEqual(args, c.expect.args)
      }
    })
  }

  it('caps the echoed raw snippet on huge truncated payloads', () => {
    const huge = `{"command": "${'x'.repeat(2_000)}`
    const { args, error } = parseToolArgs(huge)
    assert.deepEqual(args, {})
    assert.ok(error)
    assert.ok(error.includes('…'), 'snippet should be elided')
    assert.ok(error.length < 700, `error should stay bounded, was ${String(error.length)}`)
  })
})
