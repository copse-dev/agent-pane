import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRemoteEditorLaunch } from './editor-detect.ts'

describe('buildRemoteEditorLaunch', () => {
  it('builds a vscode-remote folder URI for VS Code', () => {
    const launch = buildRemoteEditorLaunch(
      {
        editor: { id: 'vscode', name: 'VS Code', macAppNames: [] },
        cliPath: '/usr/bin/code',
        macAppPath: null,
      },
      '/home/me/project',
      'my-server',
      'linux',
    )
    assert.equal(launch.command, '/usr/bin/code')
    assert.deepEqual(launch.args, [
      '--folder-uri',
      'vscode-remote://ssh-remote+my-server/home/me/project',
    ])
  })
})
