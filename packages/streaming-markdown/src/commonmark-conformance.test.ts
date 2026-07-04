// CommonMark conformance harness for the *at-rest* renderer.
//
// `renderMarkdown()` is app-specific in places (decorated links, highlighted code,
// mermaid, etc.), but CommonMark is the structural reference we grow toward.
// Every spec example is run through `renderMarkdown` and compared (after the
// spec's own HTML normalizer) against the expected output. The set of examples
// we currently satisfy is pinned in `conformance-baseline.json`. The test fails
// if that set changes in either direction:
//   - fewer passing examples  → a regression in a construct we used to handle.
//   - more passing examples    → an improvement; re-run with
//     `UPDATE_COMMONMARK_BASELINE=1` to record it.
//
// Full spec conformance is not required today, but new renderer work should not
// regress the baseline and should land improvements when the change is focused.
//
// Streaming is intentionally NOT conformance-tested: partial-line output is
// expected to differ from the final at-rest render (the live tail is escaped
// plain text), so only `renderMarkdown` is measured here.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderMarkdown } from './renderer.ts'
import { stripAppCodeDecorations } from './highlight.ts'
import { stripAppImageAttributes, stripAppLinkAttributes } from './inline-links.ts'
import { normalizeHtml } from '../tests/commonmark/normalize.ts'
import {
  loadConformanceBaseline,
  type ConformanceBaseline,
} from '../tests/commonmark/baseline-examples.ts'
import {
  commonMarkSpecVersion,
  loadCommonMarkSpec,
  type SpecExample,
} from '../tests/commonmark/load-spec.ts'

const SPEC_VERSION = commonMarkSpecVersion()
const spec = loadCommonMarkSpec()

function conforms(example: SpecExample): boolean {
  const html = stripAppCodeDecorations(
    stripAppImageAttributes(stripAppLinkAttributes(renderMarkdown(example.markdown))),
  )
  return normalizeHtml(html) === normalizeHtml(example.html)
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
    const baseline: ConformanceBaseline = {
      specVersion: SPEC_VERSION,
      source: `commonmark-spec@${SPEC_VERSION} (devDependency)`,
      note: 'Examples from the official CommonMark spec that renderMarkdown() satisfies at rest, after the spec normalizer. This is a regression baseline, not a conformance goal — the renderer is intentionally app-specific and escapes untrusted HTML rather than passing it through (sanitize-at-the-sink; see sanitize.ts and #600). The HTML blocks (44 examples) and Raw HTML (20 examples) sections fail by design, so 652/652 is not the target; excluding those 64 HTML examples the in-scope conformance ceiling is 588. Per-section current pass counts are in summaryBySection.',
      total: spec.length,
      passing,
      summaryBySection: summarize(passingSet),
    }
    writeFileSync(
      resolve(
        process.cwd(),
        'packages/streaming-markdown/tests/fixtures/commonmark/conformance-baseline.json',
      ),
      JSON.stringify(baseline, null, 2) + '\n',
    )
    it('regenerated the conformance baseline', () => {
      assert.ok(passing.length > 0, 'expected at least one conforming example')
    })
    return
  }

  const baseline = loadConformanceBaseline()

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
