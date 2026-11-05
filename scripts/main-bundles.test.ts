import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { STANDALONE_MAIN_BUNDLES } from './main-bundles.mts'
import { MAIN_EXTERNALS, MAIN_LOG_OVERRIDE } from './main-externals.mts'
import { build } from 'esbuild'
import { resolve } from 'node:path'

describe('main bundle config (#2432)', () => {
  it('elevates require-resolve-not-external to a build error by default', () => {
    assert.equal(MAIN_LOG_OVERRIDE['require-resolve-not-external'], 'error')
  })

  it('keeps jsdom external to the main bundle', () => {
    assert.ok((MAIN_EXTERNALS as readonly string[]).includes('jsdom'))
  })

  it('marks the container worker bundle jsdom pulls in without downgrading the error', () => {
    const worker = STANDALONE_MAIN_BUNDLES.find(
      (b) => b.outfile === 'dist/main/thread-container-worker.cjs',
    )
    if (!worker) throw new Error('thread-container-worker bundle entry should exist')
    // jsdom is bundled here (it is external to the main bundle instead), and
    // jsdom's own require.resolve('./xhr-sync-worker.js') is unbundlable by
    // path. Marking it external stops esbuild's require-resolve-not-external
    // warning without silencing the check for any other module, so a real
    // future regression still fails the build via MAIN_LOG_OVERRIDE's default.
    assert.ok(worker.external?.includes('./xhr-sync-worker.js'))
    assert.equal(
      worker.logOverride,
      undefined,
      'no per-bundle downgrade of require-resolve-not-external should be needed',
    )
  })

  it('keeps the shared ChatGPT plan service independent of desktop Electron', async () => {
    const result = await build({
      entryPoints: ['src/main/services/providers/chatgpt-plan-service.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
      alias: { '@shared': resolve('src/shared') },
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const desktopImports = Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
      input.imports.filter((entry) => entry.path === 'electron').map(() => file),
    )
    assert.deepEqual(desktopImports, [], 'shared provider service must use host-injected actions')
  })
})
