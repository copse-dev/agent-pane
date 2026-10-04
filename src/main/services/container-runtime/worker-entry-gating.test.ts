import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { STANDALONE_MAIN_BUNDLES } from '../../../../scripts/main-bundles.mts'
import {
  HARBOR_WORKER_ENTRY,
  bundleHarborWorker,
  bundleThreadContainerWorker,
} from '../../../../scripts/lib/thread-container-worker-bundle.mts'

/**
 * Option-1 gating for the benchmark-only external container boundary
 * (`docs/plans/thread-in-container.md`, decision A20).
 *
 * `declareExternalContainerBoundary` declares the container tier with no host
 * attestation. It is safe only because nothing the product ships can reach it:
 * it is called from `worker-entry-harbor.ts`, which is built as its own bundle
 * under `dist-test/`. These tests fail if the product worker entry, anything it
 * imports, the product bundle list, or the product bundle's bytes ever gain a
 * path to it.
 */

const ROOT = resolve(import.meta.dirname, '../../../..')
const PRODUCT_ENTRY = 'src/main/services/container-runtime/worker-entry.ts'
const DECLARE = 'declareExternalContainerBoundary'
/** The literal marker the function writes into its synthetic record. */
const MARKER = 'external-boundary-unattested'
/**
 * The benchmark tuning surface (`harbor-tuning.mts`). It is read only by the Harbor
 * entry and the host driver; none of these may appear in anything the product ships.
 */
const TUNING_TRACES = [
  'harbor-tuning',
  'tuning.json',
  'tuning.applied.json',
  'COPSE_HARBOR_TUNING',
  'HARBOR_TUNING_FILE',
  'decodeHarborWorkerTuning',
]

/** Relative `import … from './x.ts'` / `import('./x.ts')` / `export … from` specifiers. */
function relativeImports(source: string): string[] {
  const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  )
  return specifiers.filter((specifier) => specifier.length > 0)
}

/** Every repo file the product entry reaches through relative imports. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>()
  const queue = [resolve(ROOT, entry)]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
      queue.push(resolve(dirname(file), specifier))
    }
  }
  return [...seen]
}

describe('benchmark-only external container boundary is unreachable from the product worker', () => {
  it('the product entry reaches neither the Harbor entry nor a caller of the declare function', () => {
    const reachable = reachableFrom(PRODUCT_ENTRY)
    assert.ok(reachable.length > 10, 'the import walk found the product worker graph')
    const harborEntry = resolve(ROOT, HARBOR_WORKER_ENTRY)
    assert.ok(!reachable.includes(harborEntry), 'the product worker imports the Harbor entry')
    const definition = resolve(ROOT, 'src/main/services/security/runtime-containment.ts')
    for (const file of reachable) {
      if (file === definition) continue
      const source = readFileSync(file, 'utf8')
      assert.ok(!source.includes(DECLARE), `${file} references ${DECLARE}`)
      assert.ok(!source.includes('worker-entry-harbor'), `${file} references the Harbor entry`)
      assert.ok(!source.includes(MARKER), `${file} mentions the synthetic attestation marker`)
      for (const trace of TUNING_TRACES) {
        assert.ok(!source.includes(trace), `${file} references the benchmark tuning (${trace})`)
      }
    }
  })

  it('the product entry, the shared worker and the run spec read no switch for it', () => {
    for (const file of [
      PRODUCT_ENTRY,
      'src/main/services/container-runtime/worker-main.ts',
      'src/main/services/container-runtime/run-spec.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      assert.ok(!/harbor/i.test(source), `${file} mentions the benchmark entry`)
      assert.ok(!/external[-_ ]?(container[-_ ]?)?boundary/i.test(source), file)
      for (const trace of TUNING_TRACES) {
        assert.ok(!source.includes(trace), `${file} reads the benchmark tuning (${trace})`)
      }
    }
  })

  it('only the Harbor entry (and the tuning module and its test) under src/ and packages/ touch the tuning', () => {
    const holders: string[] = []
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (/\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(entry.name)) {
          const source = readFileSync(path, 'utf8')
          if (TUNING_TRACES.some((trace) => source.includes(trace)))
            holders.push(relative(ROOT, path))
        }
      }
    }
    for (const dir of ['src', 'packages']) visit(join(ROOT, dir))
    assert.deepEqual(holders.sort(), [
      'src/main/services/container-runtime/harbor-tuning.mts',
      'src/main/services/container-runtime/harbor-tuning.test.ts',
      'src/main/services/container-runtime/worker-entry-gating.test.ts',
      'src/main/services/container-runtime/worker-entry-harbor.ts',
    ])
  })

  it('the only callers of the declare function are the Harbor entry and its tests', () => {
    const holders: string[] = []
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (/\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(entry.name)) {
          if (readFileSync(path, 'utf8').includes(DECLARE)) holders.push(relative(ROOT, path))
        }
      }
    }
    for (const dir of ['src', 'scripts', 'packages']) visit(join(ROOT, dir))
    assert.deepEqual(holders.sort(), [
      'src/main/services/container-runtime/worker-entry-gating.test.ts',
      'src/main/services/container-runtime/worker-entry-harbor.ts',
      'src/main/services/security/runtime-containment.test.ts',
      'src/main/services/security/runtime-containment.ts',
    ])
  })

  it('the Harbor entry is not a shipped bundle', () => {
    for (const bundle of STANDALONE_MAIN_BUNDLES) {
      assert.ok(!/harbor/i.test(bundle.entry), `${bundle.entry} is a shipped bundle entry`)
      assert.ok(!/harbor/i.test(bundle.outfile), `${bundle.outfile} is a shipped bundle output`)
      assert.ok(bundle.outfile.startsWith('dist/'), `${bundle.outfile} is outside dist/`)
    }
  })

  it('the Harbor bundle refuses to be written outside dist-test/', async () => {
    await assert.rejects(
      bundleHarborWorker(join(ROOT, 'dist', 'main', 'thread-container-worker.cjs')),
      /benchmark-only/,
    )
    await assert.rejects(bundleHarborWorker(join(tmpdir(), 'worker-harbor.cjs')), /benchmark-only/)
  })

  it('only the Harbor entry raises the recovery-stream cap; the product entry keeps the product cap', () => {
    const product = readFileSync(resolve(ROOT, PRODUCT_ENTRY), 'utf8')
    const harbor = readFileSync(
      resolve(ROOT, 'src/main/services/container-runtime/worker-entry-harbor.ts'),
      'utf8',
    )
    assert.ok(!product.includes('reasoningRecoveryMaxTokens'))
    assert.match(harbor, /reasoningRecoveryMaxTokens:\s*recoveryMaxTokens/)
    assert.match(
      harbor,
      /tuning\.reasoningRecoveryMaxTokens \?\? HARBOR_REASONING_RECOVERY_MAX_TOKENS/,
    )
  })

  it('the product bundle contains no trace of it, and the Harbor bundle does (so the check can see it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-worker-gating-'))
    mkdirSync(join(ROOT, 'dist-test'), { recursive: true })
    const harborDir = mkdtempSync(join(ROOT, 'dist-test', 'gating-'))
    try {
      const product = readFileSync(
        await bundleThreadContainerWorker(join(dir, 'product-worker.cjs')),
        'utf8',
      )
      for (const forbidden of [
        DECLARE,
        MARKER,
        'worker-entry-harbor',
        'COPSE_HARBOR_RUN_DIR',
        ...TUNING_TRACES,
      ]) {
        assert.ok(!product.includes(forbidden), `the product worker bundle contains ${forbidden}`)
      }
      // The product's own declare path is in it, so the absence above is not an empty bundle.
      assert.ok(product.includes('Refusing to declare container containment'))
      const harbor = readFileSync(
        await bundleHarborWorker(join(harborDir, 'harbor-worker.cjs')),
        'utf8',
      )
      assert.ok(harbor.includes(MARKER))
      assert.ok(harbor.includes('COPSE_HARBOR_RUN_DIR'))
      assert.ok(harbor.includes('tuning.json'))
      assert.ok(harbor.includes('tuning.applied.json'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(harborDir, { recursive: true, force: true })
    }
  })
})
