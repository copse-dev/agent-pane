// Replays the tool-call dialect conformance corpus (#752) through the text
// tool-call parser. The corpus is data, not code, so that every new provider
// dialect quirk (Cursor <function=…>, MiniMax delimiters/<invoke>, …) lands as
// a fixture entry the parser must keep honoring — the BFCL-style "replay, don't
// re-derive" tier of the benchmark plan (docs/plans/industry-benchmarks.md).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recoverTextToolCalls, stripTextToolCallBlocks } from './parse-text-tool-calls.ts'
import { z } from 'zod'

interface RecoverCase {
  id: string
  description: string
  input: string
  expect: {
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>
    cleanedTextIncludes?: string[] | undefined
    cleanedTextExcludes?: string[] | undefined
    keptRawBlocks?: boolean | undefined
  }
}

interface StripCase {
  id: string
  description: string
  input: string
  expected: string
}

interface DialectCorpus {
  recover: RecoverCase[]
  strip: StripCase[]
}

const dialectCorpusSchema: z.ZodType<DialectCorpus> = z.object({
  recover: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      input: z.string(),
      expect: z.object({
        toolCalls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) })),
        cleanedTextIncludes: z.array(z.string()).optional(),
        cleanedTextExcludes: z.array(z.string()).optional(),
        keptRawBlocks: z.boolean().optional(),
      }),
    }),
  ),
  strip: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      input: z.string(),
      expected: z.string(),
    }),
  ),
})

const corpusPath = join(process.cwd(), 'tests/fixtures/tool-call-dialect-corpus.json')
const corpus = dialectCorpusSchema.parse(JSON.parse(readFileSync(corpusPath, 'utf8')) as unknown)

describe('tool-call dialect corpus: recoverTextToolCalls', () => {
  for (const c of corpus.recover) {
    it(`${c.id} — ${c.description}`, () => {
      const { toolCalls, cleanedText, keptRawBlocks } = recoverTextToolCalls(c.input)
      assert.deepEqual(
        toolCalls.map((t) => ({ name: t.name, args: t.args })),
        c.expect.toolCalls,
      )
      for (const s of c.expect.cleanedTextIncludes ?? []) {
        assert.ok(cleanedText.includes(s), `cleanedText should include ${JSON.stringify(s)}`)
      }
      for (const s of c.expect.cleanedTextExcludes ?? []) {
        assert.ok(!cleanedText.includes(s), `cleanedText should not include ${JSON.stringify(s)}`)
      }
      if (c.expect.keptRawBlocks !== undefined) {
        assert.equal(keptRawBlocks, c.expect.keptRawBlocks)
      }
    })
  }
})

describe('tool-call dialect corpus: stripTextToolCallBlocks', () => {
  for (const c of corpus.strip) {
    it(`${c.id} — ${c.description}`, () => {
      assert.equal(stripTextToolCallBlocks(c.input), c.expected)
    })
  }
})
