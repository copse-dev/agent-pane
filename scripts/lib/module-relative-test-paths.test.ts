import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { rewriteModuleRelativeTestPaths } from './module-relative-test-paths.mts'

// This transform also runs while bundling its own test. Assemble the fixture
// tokens so the outer invocation cannot rewrite them before the assertion runs.
const SOURCE = [
  ['export const url = import.meta.', 'url'].join(''),
  ['export const metaDir = import.meta.', 'dirname'].join(''),
  ['export const file = __file', 'name'].join(''),
  ['export const dir = __dir', 'name'].join(''),
].join('\n')

describe('rewriteModuleRelativeTestPaths', () => {
  it('writes paths containing replacement tokens literally', () => {
    for (const segment of ['$&', '$$', String.raw`$\``, "$'"]) {
      const sourcePath = `/tmp/work${segment}space/src/example.test.ts`
      const outputPath = `/tmp/work${segment}space/dist-test/src/example.test.mjs`

      assert.equal(
        rewriteModuleRelativeTestPaths(SOURCE, sourcePath, outputPath),
        [
          `export const url = ${JSON.stringify(pathToFileURL(sourcePath).href)}`,
          `export const metaDir = ${JSON.stringify(dirname(sourcePath))}`,
          `export const file = ${JSON.stringify(outputPath)}`,
          `export const dir = ${JSON.stringify(dirname(outputPath))}`,
        ].join('\n'),
        segment,
      )
    }
  })

  it('rewrites every occurrence before modules enter shared chunks', () => {
    const sourcePath = '/tmp/work/src/example.test.ts'
    const outputPath = '/tmp/work/dist-test/src/example.test.mjs'
    const rewritten = rewriteModuleRelativeTestPaths(
      [
        ['import.meta.', 'url'].join(''),
        ['import.meta.', 'url'].join(''),
        ['__dir', 'name'].join(''),
        ['__dir', 'name'].join(''),
      ].join(' + '),
      sourcePath,
      outputPath,
    )

    assert.equal(rewritten.match(/file:\/\/\/tmp\/work\/src\/example\.test\.ts/g)?.length, 2)
    assert.equal(rewritten.match(/"\/tmp\/work\/dist-test\/src"/g)?.length, 2)
  })
})
