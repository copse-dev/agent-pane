// CommonMark conformance harness for the *at-rest* renderer.
//
// `renderMarkdown()` is a deliberately small, app-specific renderer — not a
// CommonMark implementation (see README.md: "Not a markdown library — keep it
// that way."). It maps ATX `#` levels to `<h1>`–`<h6>`, decorates links with in-app
// attributes, highlights fenced code, etc. So we do not expect full spec
// conformance and we do not chase 100%.
//
// What this test *does* give us: every example from the official CommonMark
// spec is run through `renderMarkdown` and compared (after the spec's own HTML
// normalization) against the expected output. The set of examples we currently
// satisfy is pinned in `conformance-baseline.json`. The test fails if that set
// changes in either direction:
//   - fewer passing examples  → a regression in a construct we used to handle.
//   - more passing examples    → an improvement; re-run with
//     `UPDATE_COMMONMARK_BASELINE=1` to record it.
//
// Streaming is intentionally NOT conformance-tested: partial-line output is
// expected to differ from the final at-rest render (the live tail is escaped
// plain text), so only `renderMarkdown` is measured here.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderMarkdown } from './renderer.ts'
import { normalizeHtml } from '../../../tests/commonmark/normalize.ts'
import {
  commonMarkSpecVersion,
  loadCommonMarkSpec,
  type SpecExample,
} from '../../../tests/commonmark/load-spec.ts'

interface Baseline {
  specVersion: string
  source: string
  note: string
  total: number
  passing: number[]
  summaryBySection: Record<string, { pass: number; total: number }>
}

const SPEC_VERSION = commonMarkSpecVersion()
const ROOT = process.cwd()
const BASELINE_PATH = resolve(ROOT, 'tests/fixtures/commonmark/conformance-baseline.json')

function readJson(path: string, hint: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`Missing ${path}. ${hint}`)
  }
  return JSON.parse(raw)
}

const spec = loadCommonMarkSpec()

function conforms(example: SpecExample): boolean {
  return normalizeHtml(renderMarkdown(example.markdown)) === normalizeHtml(example.html)
}

function computePassing(): number[] {
  return spec.filter(conforms).map((e) => e.example)
}

function summarize(passing: Set<number>): Record<string, { pass: number; total: number }> {
  const summary: Record<string, { pass: number; total: number }> = {}
  for (const e of spec) {
    const bucket = (summary[e.section] ??= { pass: 0, total: 0 })
    bucket.total++
    if (passing.has(e.example)) bucket.pass++
  }
  return summary
}

describe('CommonMark conformance (at rest)', () => {
  const passing = computePassing()
  const passingSet = new Set(passing)

  if (process.env['UPDATE_COMMONMARK_BASELINE'] === '1') {
    const baseline: Baseline = {
      specVersion: SPEC_VERSION,
      source: `commonmark-spec@${SPEC_VERSION} (devDependency)`,
      note: 'Examples from the official CommonMark spec that renderMarkdown() satisfies at rest, after the spec normalizer. This is a regression baseline, not a conformance goal — the renderer is intentionally app-specific.',
      total: spec.length,
      passing,
      summaryBySection: summarize(passingSet),
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
    it('regenerated the conformance baseline', () => {
      assert.ok(passing.length > 0, 'expected at least one conforming example')
    })
    return
  }

  const baseline = readJson(
    BASELINE_PATH,
    'Run `UPDATE_COMMONMARK_BASELINE=1 npm test` to generate it.',
  ) as Baseline

  it('pins the spec fixture version', () => {
    assert.equal(baseline.specVersion, SPEC_VERSION)
    assert.equal(baseline.total, spec.length)
  })

  it('matches the recorded set of conforming spec examples', () => {
    const expected = new Set(baseline.passing)
    const regressions = baseline.passing.filter((n) => !passingSet.has(n))
    const improvements = passing.filter((n) => !expected.has(n))
    const detail = (nums: number[]): string =>
      nums
        .map((n) => {
          const ex = spec.find((e) => e.example === n)
          return `#${String(n)} (${ex?.section ?? '?'})`
        })
        .join(', ')
    assert.deepEqual(
      passing,
      baseline.passing,
      [
        regressions.length
          ? `Regressions (examples that no longer conform): ${detail(regressions)}.`
          : '',
        improvements.length
          ? `Improvements (newly conforming): ${detail(improvements)}. Re-run with UPDATE_COMMONMARK_BASELINE=1 to record them.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  })
})
