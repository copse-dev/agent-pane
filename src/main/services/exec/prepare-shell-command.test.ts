import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setSetting } from '../storage/settings.ts'
import { prepareShellCommand } from './prepare-shell-command.ts'

const LAUNCHER = { execPath: '/copse/node', scriptPath: '/copse/package-firewall.js' }

describe('shared shell package preparation', () => {
  afterEach(async () => {
    await setSetting('safeInstallEnabled', true)
  })

  it('does not require a package proxy for ordinary local work', () => {
    const result = prepareShellCommand('printf local', process.cwd(), () => {
      throw new Error('ordinary work must not resolve a package proxy')
    })
    assert.ok('command' in result)
    assert.equal(result.command, 'printf local')
    assert.equal(result.banner, '')
  })

  it('wraps a JavaScript install and disables lifecycle scripts without mutating the host env', () => {
    const original = process.env['npm_config_ignore_scripts']
    const result = prepareShellCommand('npm install example-package', process.cwd(), () => LAUNCHER)
    assert.ok('command' in result)
    assert.match(result.command, /package-firewall\.js/)
    assert.match(result.command, /npm install example-package/)
    assert.equal(result.env['npm_config_ignore_scripts'], 'true')
    assert.match(result.banner, /install scripts disabled/)
    assert.equal(process.env['npm_config_ignore_scripts'], original)
  })

  it('wraps a non-JavaScript download without claiming npm script protection', () => {
    const result = prepareShellCommand('cargo fetch', process.cwd(), () => LAUNCHER)
    assert.ok('command' in result)
    assert.match(result.command, /package-firewall\.js/)
    assert.match(result.command, /cargo fetch/)
    assert.equal(result.banner, '')
  })

  it('fails closed when the package proxy cannot be launched', () => {
    const result = prepareShellCommand('npm install example-package', process.cwd(), () => {
      throw new Error('proxy bundle unavailable')
    })
    assert.deepEqual(result, { refused: 'Package install cancelled: proxy bundle unavailable.' })
  })

  it('keeps the supported safe-install setting effective for both callers', async () => {
    await setSetting('safeInstallEnabled', false)
    const command = 'npm install example-package'
    const result = prepareShellCommand(command, process.cwd(), () => {
      throw new Error('disabled preparation must not resolve a package proxy')
    })
    assert.ok('command' in result)
    assert.equal(result.command, command)
    assert.equal(result.banner, '')
  })
})
