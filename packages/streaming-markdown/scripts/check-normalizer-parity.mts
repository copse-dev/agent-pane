// Differential conformity check for the JS CommonMark normalizer.
//
// `tests/commonmark/normalize.ts` is a hand port of the spec's reference
// normalizer (`tests/commonmark/normalize.py`). This script proves the port
// stays faithful by normalizing the same HTML with both implementations and
// asserting:
//
//   1. PASS-SET PARITY (the guarantee the conformance test relies on): the set
//      of spec examples `renderMarkdown` satisfies is identical whether verdicts
//      are computed with the JS normalizer or the Python reference. This must
//      match exactly.
//   2. STRING PARITY: for every spec example, JS- and Python-normalized output
//      of both the expected HTML and our rendered HTML are byte-identical —
//      except for a small, documented allowlist of pathological raw-HTML /
//      comment inputs where Python's `HTMLParser` and our tokenizer legitimately
//      differ (none of which affect any conformance verdict).
//
// Requires python3 (present on CI runners); fails fast if it is missing. Run via
// `npm run check:normalizer-parity`. Not part of `npm run check` so contributors
// without python can still run the default gates.
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const NORMALIZE_PY = resolve(ROOT, 'tests/commonmark/normalize.py')
const PYTHON = process.env['PYTHON'] ?? 'python3'

// Examples where our tokenizer and Python's stdlib HTMLParser legitimately
// disagree on how to normalize malformed/raw HTML or comment edge cases. None
// change a conformance verdict (the renderer fails all of these regardless), so
// they are documented exceptions rather than bugs. `kind` pins which side(s)
// diverge so a new divergence cannot hide behind an existing entry.
const ALLOWED_STRING_DIVERGENCES: Record<
  number,
  { kind: 'expected' | 'rendered' | 'both'; reason: string }
> = {
  156: {
    kind: 'expected',
    reason: 'HTML block: unterminated <div ...> across lines parsed differently',
  },
  157: {
    kind: 'expected',
    reason: 'HTML block: bare attribute (<div class foo) parsed differently',
  },
  158: { kind: 'expected', reason: 'HTML block: stray < inside raw text parsed differently' },
  173: {
    kind: 'expected',
    reason: 'HTML block: <style> raw-text element swallows following text in HTMLParser',
  },
  616: {
    kind: 'expected',
    reason: 'Raw HTML: malformed tag with quoted attribute parsed differently',
  },
  626: { kind: 'expected', reason: 'Raw HTML: empty comment <!--> whitespace handling differs' },
  628: { kind: 'expected', reason: 'Raw HTML: <!ELEMENT ...> declaration rendered differently' },
}

function die(message: string): never {
  console.error(`check-normalizer-parity: ${message}`)
  process.exit(1)
}

if (!existsSync(NORMALIZE_PY)) {
  die(
    `reference normalizer missing at ${NORMALIZE_PY}. Run 'node scripts/fetch-reference-normalizer.mts' first (or use 'npm run check:normalizer-parity', which fetches it).`,
  )
}
const probe = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' })
if (probe.status !== 0) {
  die(
    `could not run '${PYTHON}' (set $PYTHON to override). ${probe.error?.message ?? probe.stderr}`,
  )
}

interface SpecExample {
  markdown: string
  html: string
  example: number
  section: string
}
interface Harness {
  renderMarkdown: (raw: string) => string
  normalizeHtml: (html: string) => string
  loadCommonMarkSpec: () => SpecExample[]
}

// Bundle the renderer + JS normalizer + spec loader into one importable module
// (the same way scripts/run-tests.mts bundles tests), then load it via data URL.
const entry = [
  `export { renderMarkdown } from ${JSON.stringify(resolve(ROOT, 'src/renderer.ts'))}`,
  `export { normalizeHtml } from ${JSON.stringify(resolve(ROOT, 'tests/commonmark/normalize.ts'))}`,
  `export { loadCommonMarkSpec } from ${JSON.stringify(resolve(ROOT, 'tests/commonmark/load-spec.ts'))}`,
].join('\n')
const bundled = await esbuild.build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'parity-entry.ts', loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  external: ['electron', 'node-pty', 'jsdom', '@mozilla/readability', 'turndown'],
})
const bundledOutput = bundled.outputFiles[0]
if (!bundledOutput) die('esbuild produced no output files')
const harness = (await import(
  'data:text/javascript;base64,' + Buffer.from(bundledOutput.text).toString('base64')
)) as Harness

const spec = harness.loadCommonMarkSpec()

// JS side: render every example, then normalize expected + rendered with the JS port.
const inputs = spec.map((e) => ({
  example: e.example,
  rendered: harness.renderMarkdown(e.markdown),
  expected: e.html,
}))
const jsNorm = new Map<number, { expected: string; rendered: string }>()
for (const i of inputs) {
  jsNorm.set(i.example, {
    expected: harness.normalizeHtml(i.expected),
    rendered: harness.normalizeHtml(i.rendered),
  })
}

// Python side: normalize the identical inputs with the reference normalizer.
const dir = mkdtempSync(join(tmpdir(), 'normalizer-parity-'))
const inputsPath = join(dir, 'inputs.json')
const outputsPath = join(dir, 'outputs.json')
const driverPath = join(dir, 'driver.py')
writeFileSync(inputsPath, JSON.stringify(inputs))
writeFileSync(
  driverPath,
  [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(dirname(NORMALIZE_PY))})`,
    'from normalize import normalize_html',
    `inputs = json.load(open(${JSON.stringify(inputsPath)}))`,
    'out = {}',
    'for i in inputs:',
    '    out[i["example"]] = {"expected": normalize_html(i["expected"]), "rendered": normalize_html(i["rendered"])}',
    `json.dump(out, open(${JSON.stringify(outputsPath)}, "w"))`,
  ].join('\n'),
)
const run = spawnSync(PYTHON, [driverPath], { encoding: 'utf8' })
if (run.status !== 0) die(`python normalizer failed:\n${run.stderr}`)
const pyNorm = JSON.parse(readFileSync(outputsPath, 'utf8')) as Record<
  string,
  { expected: string; rendered: string }
>

// 1. Pass-set parity.
const jsPass = new Set<number>()
const pyPass = new Set<number>()
for (const e of spec) {
  const js = jsNorm.get(e.example)
  const py = pyNorm[String(e.example)]
  if (!js || !py) die(`missing normalized output for example #${String(e.example)}`)
  if (js.expected === js.rendered) jsPass.add(e.example)
  if (py.expected === py.rendered) pyPass.add(e.example)
}
const jsOnly = [...jsPass].filter((n) => !pyPass.has(n)).sort((a, b) => a - b)
const pyOnly = [...pyPass].filter((n) => !jsPass.has(n)).sort((a, b) => a - b)

// 2. String parity (allowlist-aware).
const unexpected: string[] = []
const usedAllow = new Set<number>()
for (const e of spec) {
  const js = jsNorm.get(e.example)
  const py = pyNorm[String(e.example)]
  if (!js || !py) die(`missing normalized output for example #${String(e.example)}`)
  const expectedDiffers = js.expected !== py.expected
  const renderedDiffers = js.rendered !== py.rendered
  if (!expectedDiffers && !renderedDiffers) continue
  const allow = ALLOWED_STRING_DIVERGENCES[e.example]
  const allowed =
    allow &&
    (allow.kind === 'both' ||
      (allow.kind === 'expected' && expectedDiffers && !renderedDiffers) ||
      (allow.kind === 'rendered' && renderedDiffers && !expectedDiffers))
  if (allowed) {
    usedAllow.add(e.example)
    continue
  }
  const which = [expectedDiffers ? 'expected' : '', renderedDiffers ? 'rendered' : '']
    .filter(Boolean)
    .join('+')
  unexpected.push(`#${String(e.example)} (${e.section}) [${which}]`)
}
const staleAllow = Object.keys(ALLOWED_STRING_DIVERGENCES)
  .map(Number)
  .filter((n) => !usedAllow.has(n))
  .sort((a, b) => a - b)

const problems: string[] = []
if (jsOnly.length || pyOnly.length) {
  problems.push(
    'Pass-set parity broken between JS normalizer and reference normalize.py:' +
      (jsOnly.length ? `\n  pass only under JS: ${jsOnly.join(', ')}` : '') +
      (pyOnly.length ? `\n  pass only under py: ${pyOnly.join(', ')}` : ''),
  )
}
if (unexpected.length) {
  problems.push(
    `Unexpected normalization divergence on ${String(unexpected.length)} example(s) — JS normalizer drifted from normalize.py:\n  ${unexpected.join('\n  ')}\n` +
      'If a new divergence is genuinely a pathological raw-HTML case, add it to ALLOWED_STRING_DIVERGENCES with a reason; otherwise fix tests/commonmark/normalize.ts.',
  )
}
if (staleAllow.length) {
  problems.push(
    `Stale ALLOWED_STRING_DIVERGENCES entries (no longer diverge — drop them): ${staleAllow.join(', ')}`,
  )
}

if (problems.length) die(problems.join('\n\n'))

console.log(
  `check-normalizer-parity: OK — JS normalizer matches normalize.py across all ${String(spec.length)} examples ` +
    `(pass set ${String(jsPass.size)}/${String(spec.length)}; ${String(usedAllow.size)} documented raw-HTML divergence(s)).`,
)
