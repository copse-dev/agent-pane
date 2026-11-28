import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  CI_TEST_FILE_CONCURRENCY,
  MAX_LOCAL_TEST_FILE_CONCURRENCY,
} from './lib/test-concurrency.mts'

const runner = readFileSync(new URL('./run-tests.mts', import.meta.url), 'utf8')

describe('unit test runner build contract', () => {
  it('shares application code across independent ESM test entries', () => {
    assert.match(runner, /format: 'esm'/)
    assert.match(runner, /splitting: true/)
    assert.match(runner, /chunkNames: '_chunks\/\[name\]-\[hash\]'/)
    assert.match(runner, /outExtension: \{ '\.js': '\.mjs' \}/)
  })

  it('builds the complete entry graph once instead of bundling standalone batches', () => {
    assert.match(runner, /await esbuild\.build\(buildOptions\)/)
    assert.doesNotMatch(runner, /BUNDLE_BATCH_SIZE|buildBatch|isEsbuildServiceDead/)
  })

  it('runs only emitted test entries, never shared chunks', () => {
    assert.match(runner, /outputDir\.replace/)
    assert.match(runner, /\*\*\/\*\.test\.mjs/)
    assert.match(runner, /const fixedOutputDir = 'dist-test'/)
    assert.doesNotMatch(runner, /dist-test\/\*\*\/\*\.mjs'/)
  })

  it('bounds file concurrency so subprocess-heavy suites keep their safety deadlines', () => {
    // CI's four and the local cap live in lib/test-concurrency.mts, whose own
    // test pins them; the runner must take its count from there.
    assert.match(runner, /const TEST_FILE_CONCURRENCY = testFileConcurrency\(\)/)
    assert.match(runner, /--test-concurrency=\$\{String\(TEST_FILE_CONCURRENCY\)\}/)
    assert.equal(CI_TEST_FILE_CONCURRENCY, 4)
    assert.equal(MAX_LOCAL_TEST_FILE_CONCURRENCY, 8)
  })

  it('preserves module-relative paths before modules enter shared chunks', () => {
    assert.match(runner, /name: 'module-relative-test-paths'/)
    assert.match(runner, /rewriteModuleRelativeTestPaths\(source, args\.path, outputPath\)/)
  })

  it('adapts Electron CommonJS properties to statically named ESM exports', () => {
    assert.match(runner, /name: 'electron-esm-interop'/)
    assert.match(runner, /return \{ path: 'electron', external: true \}/)
    assert.match(runner, /`export const \$\{name\} = electron\.\$\{name\};`/)
  })
})
