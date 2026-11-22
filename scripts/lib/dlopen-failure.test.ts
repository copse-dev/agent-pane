import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeDlopenFailures } from './dlopen-failure.mts'

const ZIP =
  '/Users/dev/agent-pane/node_modules/.pnpm/@electron-internal+extract-zip@1.0.5/node_modules/@electron-internal/extract-zip/index.darwin-universal.node'
const UUID = '<6E1B2C3D-4F5A-3B6C-8D7E-9F0A1B2C3D4E>'
const TEAM_ID_REASON = (file: string): string =>
  `code signature in ${UUID} '${file}' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs`
const TEAM_ID_DLOPEN = (file: string): string =>
  `dlopen(${file}, 0x0001): tried: '${file}' (${TEAM_ID_REASON(file)}), ` +
  `'/System/Volumes/Preboot/Cryptexes/OS${file}' (no such file), '${file}' (${TEAM_ID_REASON(file)})`

describe('describeDlopenFailures', () => {
  it('restates a library-validation refusal from a napi-rs cause chain', () => {
    const stderr = [
      'Error: Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828).',
      '    at file:///Users/dev/agent-pane/node_modules/.pnpm/binding.js:613:11 {',
      `  [cause]: Error: ${TEAM_ID_DLOPEN(ZIP)}`,
      '      at Object..node (node:internal/modules/cjs/loader:1921:18)',
      "      code: 'ERR_DLOPEN_FAILED'",
      '  }',
      '}',
    ].join('\n')
    assert.deepEqual(describeDlopenFailures(stderr), [
      `dlopen failed for ${ZIP}`,
      `  code signature in ${UUID} not valid for use in process:`,
      '  mapping process and mapped file (non-platform) have different Team IDs',
    ])
  })

  it('reports each failing file once and skips the source excerpt', () => {
    const icon =
      '/Users/dev/agent-pane/node_modules/@resvg/resvg-js-darwin-arm64/resvgjs.darwin-arm64.node'
    const stderr = [
      'node:internal/modules/cjs/loader:1921',
      '  return process.dlopen(module, path.toNamespacedPath(filename));',
      '                 ^',
      '',
      `Error: ${TEAM_ID_DLOPEN(icon)}`,
      `Error: ${TEAM_ID_DLOPEN(icon)}`,
    ].join('\r\n')
    assert.deepEqual(describeDlopenFailures(stderr), [
      `dlopen failed for ${icon}`,
      `  code signature in ${UUID} not valid for use in process:`,
      '  mapping process and mapped file (non-platform) have different Team IDs',
    ])
  })

  it('keeps nested parentheses and reasons in an unfamiliar format', () => {
    const wrongArch = `dlopen(${ZIP}, 0x0001): tried: '${ZIP}' (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64e' or 'arm64'))`
    const missing = 'dlopen(/tmp/x.node, 1): Library not loaded: @rpath/libfoo.dylib'
    assert.deepEqual(describeDlopenFailures(`${wrongArch}\n${missing}`), [
      `dlopen failed for ${ZIP}`,
      "  mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64e' or 'arm64')",
      'dlopen failed for /tmp/x.node',
      '  Library not loaded:',
      '  @rpath/libfoo.dylib',
    ])
  })

  it('returns nothing for output without a dyld failure', () => {
    assert.deepEqual(describeDlopenFailures('Error: exit 1\n    at main (file.mts:1:1)'), [])
  })
})
