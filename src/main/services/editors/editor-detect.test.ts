import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  KNOWN_EXTERNAL_EDITORS,
  buildEditorLaunch,
  detectExternalEditors,
  parseMockEditorIds,
} from './editor-detect.ts'

afterEach(() => {
  delete process.env['COPSE_PANEL_MOCK_EDITORS']
})

describe('parseMockEditorIds', () => {
  it('returns null when the env var is unset (real detection)', () => {
    assert.equal(parseMockEditorIds(undefined), null)
  })

  it('parses a comma list and drops unknown ids', () => {
    assert.deepEqual(parseMockEditorIds('vscode, zed,not-an-editor'), ['vscode', 'zed'])
  })

  it('treats an empty value as "no editors installed"', () => {
    assert.deepEqual(parseMockEditorIds(''), [])
  })
})

describe('detectExternalEditors under the e2e mock', () => {
  it('reports exactly the mocked ids without probing the system', async () => {
    process.env['COPSE_PANEL_MOCK_EDITORS'] = 'cursor,vscode'
    const detected = await detectExternalEditors('linux')
    assert.deepEqual(
      detected.map((d) => d.editor.id),
      ['vscode', 'cursor'], // KNOWN_EXTERNAL_EDITORS order, not env order
    )
  })

  it('reports nothing when the mock list is empty', async () => {
    process.env['COPSE_PANEL_MOCK_EDITORS'] = ''
    assert.deepEqual(await detectExternalEditors('linux'), [])
  })
})

describe('buildEditorLaunch', () => {
  const vscode = KNOWN_EXTERNAL_EDITORS.find((e) => e.id === 'vscode')
  assert.ok(vscode, 'vscode must be a known editor')

  it('prefers `open -a` on macOS when the app bundle was found', () => {
    const launch = buildEditorLaunch(
      { editor: vscode, cliPath: '/usr/local/bin/code', macAppPath: '/Applications/VSC.app' },
      '/repo',
      'darwin',
    )
    assert.deepEqual(launch, { command: 'open', args: ['-a', '/Applications/VSC.app', '/repo'] })
  })

  it('falls back to the CLI on macOS without a bundle, and always elsewhere', () => {
    const cliOnly = { editor: vscode, cliPath: '/usr/local/bin/code', macAppPath: null }
    assert.deepEqual(buildEditorLaunch(cliOnly, '/repo', 'darwin'), {
      command: '/usr/local/bin/code',
      args: ['/repo'],
    })
    const linux = {
      editor: vscode,
      cliPath: '/usr/bin/code',
      macAppPath: '/Applications/VSC.app',
    }
    assert.deepEqual(buildEditorLaunch(linux, '/repo', 'linux'), {
      command: '/usr/bin/code',
      args: ['/repo'],
    })
  })

  it('throws when no launcher was detected', () => {
    assert.throws(() => {
      buildEditorLaunch({ editor: vscode, cliPath: null, macAppPath: null }, '/repo', 'linux')
    }, /No launcher/)
  })
})
