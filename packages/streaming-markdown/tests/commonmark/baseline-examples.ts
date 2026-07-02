import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadCommonMarkSpec, type SpecExample } from './load-spec.ts'

export interface ConformanceBaseline {
  specVersion: string
  source: string
  note: string
  total: number
  passing: number[]
  summaryBySection: Record<string, { pass: number; total: number }>
}

const BASELINE_PATH = resolve(
  process.cwd(),
  'packages/streaming-markdown/tests/fixtures/commonmark/conformance-baseline.json',
)

/** Pinned CommonMark conformance baseline (see `conformance-baseline.json`). */
export function loadConformanceBaseline(): ConformanceBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as ConformanceBaseline
}

/** Spec examples that currently pass the at-rest conformance baseline. */
export function loadBaselinePassingExamples(): SpecExample[] {
  const baseline = loadConformanceBaseline()
  const spec = loadCommonMarkSpec()
  const byExample = new Map(spec.map((e) => [e.example, e]))
  return baseline.passing.map((n) => {
    const ex = byExample.get(n)
    if (!ex) throw new Error(`Baseline example #${String(n)} missing from spec`)
    return ex
  })
}
