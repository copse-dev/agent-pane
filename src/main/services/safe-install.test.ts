import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectPackageInstall,
  formatSafeInstallBanner,
  posixQuote,
  wrapWithSocketFirewall,
} from './safe-install.ts'

const SH = { path: '/bin/sh', cArg: '-c' }

describe('detectPackageInstall', () => {
  it('detects npm/pnpm/yarn installs as JS managers', () => {
    for (const cmd of [
      'npm install lodash',
      'npm i',
      'npm ci',
      'pnpm install',
      'yarn add react',
      'yarn',
    ]) {
      const d = detectPackageInstall(cmd)
      assert.equal(d.isInstall, true, cmd)
      assert.equal(d.jsManager, true, cmd)
    }
  })

  it('detects pip/uv/cargo/npx installs but not as JS managers', () => {
    for (const cmd of [
      'pip install requests',
      'pip3 install requests',
      'python3 -m pip install requests',
      'uv pip install ruff',
      'uv add ruff',
      'cargo install ripgrep',
      'npx cowsay hi',
    ]) {
      const d = detectPackageInstall(cmd)
      assert.equal(d.isInstall, true, cmd)
      assert.equal(d.jsManager, false, cmd)
    }
  })

  it('ignores non-install commands', () => {
    for (const cmd of [
      'npm test',
      'npm run build',
      'ls -la && git status',
      'cargo build',
      'yarn run lint',
    ]) {
      assert.equal(detectPackageInstall(cmd).isInstall, false, cmd)
    }
  })

  it('detects an install anywhere in a compound command', () => {
    assert.equal(detectPackageInstall('git pull && npm install').isInstall, true)
    assert.equal(detectPackageInstall('echo hi; pip install requests').isInstall, true)
  })

  it('sees through leading env assignments and sudo', () => {
    assert.equal(detectPackageInstall('CI=1 npm install').isInstall, true)
    assert.equal(detectPackageInstall('sudo npm install -g typescript').jsManager, true)
  })

  it('does not re-detect an already sfw-wrapped command', () => {
    assert.equal(detectPackageInstall('sfw npm install').isInstall, false)
  })
})

describe('posixQuote', () => {
  it('wraps a plain string in single quotes', () => {
    assert.equal(posixQuote('npm install'), `'npm install'`)
  })

  it('escapes embedded single quotes', () => {
    assert.equal(posixQuote(`echo 'hi'`), `'echo '\\''hi'\\'''`)
  })
})

describe('wrapWithSocketFirewall', () => {
  it('wraps the whole command through sfw + a shell', () => {
    assert.equal(
      wrapWithSocketFirewall('npm install lodash', SH),
      `sfw /bin/sh -c 'npm install lodash'`,
    )
  })

  it('keeps compound commands intact inside the quoted shell string', () => {
    assert.equal(
      wrapWithSocketFirewall('npm install && npm test', SH),
      `sfw /bin/sh -c 'npm install && npm test'`,
    )
  })

  it('supports a custom quoter for other shells', () => {
    const winQuote = (v: string) => `"${v.replace(/"/g, '""')}"`
    assert.equal(
      wrapWithSocketFirewall('npm install', { path: 'cmd', cArg: '/c' }, winQuote),
      `sfw cmd /c "npm install"`,
    )
  })
})

describe('formatSafeInstallBanner', () => {
  it('echoes the original command, not the sfw wrapper', () => {
    const banner = formatSafeInstallBanner('npm install lodash', {
      isInstall: true,
      jsManager: true,
    })
    assert.equal(
      banner,
      '[safe-install] scanned by Socket Firewall (sfw); install scripts disabled\n$ npm install lodash\n',
    )
    assert.ok(!banner.includes('sfw /bin/sh -c'), 'wrapper plumbing must not leak into the banner')
  })

  it('omits the install-scripts note for non-JS managers', () => {
    const banner = formatSafeInstallBanner('pip install requests', {
      isInstall: true,
      jsManager: false,
    })
    assert.equal(
      banner,
      '[safe-install] scanned by Socket Firewall (sfw)\n$ pip install requests\n',
    )
  })

  it('trims surrounding whitespace from the echoed command', () => {
    const banner = formatSafeInstallBanner('  npm ci  ', { isInstall: true, jsManager: true })
    assert.ok(banner.includes('\n$ npm ci\n'))
  })
})
