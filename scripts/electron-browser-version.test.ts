import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveElectronBrowserVersion } from '../tests/e2e/helpers/electron-browser-version.ts'

describe('Electron WebDriver version resolution', () => {
  it('uses the Chromium version reported by Electron when the driver major matches', () => {
    const calls: Array<{ executable: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
    const version = resolveElectronBrowserVersion(
      '/app/Electron',
      '/app/chromedriver',
      (executable, args, env) => {
        calls.push({ executable, args, ...(env ? { env } : {}) })
        return executable.endsWith('Electron')
          ? '152.0.7977.65\n'
          : 'ChromeDriver 152.0.7977.54 (revision)\n'
      },
    )

    assert.equal(version, '152.0.7977.65')
    assert.equal(calls.length, 2)
    const [electronCall, driverCall] = calls
    assert.ok(electronCall)
    assert.ok(electronCall.env)
    assert.ok(driverCall)

    assert.deepEqual(electronCall.args, ['-p', 'process.versions.chrome'])
    assert.equal(electronCall.env['ELECTRON_RUN_AS_NODE'], '1')
    assert.deepEqual(driverCall, {
      executable: '/app/chromedriver',
      args: ['--version'],
    })
  })

  it('rejects a driver from a different Chromium major before launching a session', () => {
    assert.throws(
      () =>
        resolveElectronBrowserVersion('/app/Electron', '/app/chromedriver', (executable) =>
          executable.endsWith('Electron')
            ? '152.0.7977.65'
            : 'ChromeDriver 150.0.7871.224 (revision)',
        ),
      /requires a matching ChromeDriver major; found 150\.0\.7871\.224/,
    )
  })

  it('rejects malformed binary output with the failing program identified', () => {
    assert.throws(
      () => resolveElectronBrowserVersion('/app/Electron', '/app/chromedriver', () => ''),
      /Electron reported an invalid Chromium version: \(empty\)/,
    )
    assert.throws(
      () =>
        resolveElectronBrowserVersion('/app/Electron', '/app/chromedriver', (executable) =>
          executable.endsWith('Electron') ? '152.0.7977.65' : 'unknown',
        ),
      /ChromeDriver reported an invalid version: unknown/,
    )
  })
})
