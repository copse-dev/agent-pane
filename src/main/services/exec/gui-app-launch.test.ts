import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOpenArgv } from './gui-app-launch.ts'

describe('buildOpenArgv', () => {
  it('opens a new instance of a .app path by default', () => {
    assert.deepEqual(buildOpenArgv({ target: '/Applications/Safari.app' }), [
      '-n',
      '/Applications/Safari.app',
    ])
  })

  it('uses -a for a bare Application name', () => {
    assert.deepEqual(buildOpenArgv({ target: 'Safari', newInstance: false }), ['-a', 'Safari'])
  })

  it('forwards env via repeated --env KEY=VALUE and app args after --args', () => {
    assert.deepEqual(
      buildOpenArgv({
        target: '/tmp/Copse.app',
        env: {
          COPSE_PANEL_USER_DATA: '/tmp/user-data',
          COPSE_WORKSPACE_DIR: '/tmp/workspace',
        },
        args: ['/tmp/dist/main/index.js'],
      }),
      [
        '-n',
        '--env',
        'COPSE_PANEL_USER_DATA=/tmp/user-data',
        '--env',
        'COPSE_WORKSPACE_DIR=/tmp/workspace',
        '/tmp/Copse.app',
        '--args',
        '/tmp/dist/main/index.js',
      ],
    )
  })

  it('rejects unsafe environment keys', () => {
    assert.throws(
      () => buildOpenArgv({ target: 'Safari', env: { 'BAD KEY': 'x' } }),
      /unsafe environment entry/,
    )
  })

  it('rejects empty targets', () => {
    assert.throws(() => buildOpenArgv({ target: '  ' }), /required/)
  })
})
