import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectPackageInstall, posixQuote, wrapWithPackageFirewall } from './safe-install.ts'

const SH = { path: '/bin/sh', cArg: '-c' }
const LAUNCHER = {
  execPath: '/Apps/Copse.app/Contents/MacOS/Copse',
  scriptPath: '/Apps/dist/package-firewall.js',
}
const LAUNCH = `ELECTRON_RUN_AS_NODE=1 '${LAUNCHER.execPath}' '${LAUNCHER.scriptPath}'`

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

  it('marks npx as an ephemeral runner, not a project install', () => {
    const d = detectPackageInstall('npx tsc --noEmit')
    assert.equal(d.isInstall, true)
    assert.equal(d.isEphemeralRunner, true)
    assert.equal(d.jsManager, false)
  })

  it('does not mark npm install as an ephemeral runner', () => {
    const d = detectPackageInstall('npm install lodash')
    assert.equal(d.isInstall, true)
    assert.equal(d.isEphemeralRunner, false)
    assert.equal(d.jsManager, true)
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

  // --- #581: obfuscation must not dodge the firewall wrap / ignore_scripts -----

  it('sees through quote-splitting obfuscation of the manager token', () => {
    for (const cmd of ['n""pm install', `n''pm install`, 'p""npm add react', 'y\\arn add react']) {
      const d = detectPackageInstall(cmd)
      assert.equal(d.isInstall, true, cmd)
      assert.equal(d.jsManager, true, cmd)
    }
  })

  it('sees through a leading eval (quoted or bare)', () => {
    for (const cmd of ['eval npm install', 'eval "npm install"', `eval 'pnpm add react'`]) {
      const d = detectPackageInstall(cmd)
      assert.equal(d.isInstall, true, cmd)
      assert.equal(d.jsManager, true, cmd)
    }
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

describe('wrapWithPackageFirewall', () => {
  it('runs the whole command through the firewall launcher + a shell', () => {
    assert.equal(
      wrapWithPackageFirewall('npm install lodash', SH, LAUNCHER),
      `${LAUNCH} /bin/sh -c 'npm install lodash'`,
    )
  })

  it('keeps compound commands intact inside the quoted shell string', () => {
    assert.equal(
      wrapWithPackageFirewall('npm install && npm test', SH, LAUNCHER),
      `${LAUNCH} /bin/sh -c 'npm install && npm test'`,
    )
  })

  it('quotes launcher paths that contain spaces', () => {
    const spaced = { execPath: '/Apps/My Copse.app/Copse', scriptPath: '/Apps/My Copse.app/fw.js' }
    assert.equal(
      wrapWithPackageFirewall('pip install six', SH, spaced),
      `ELECTRON_RUN_AS_NODE=1 '/Apps/My Copse.app/Copse' '/Apps/My Copse.app/fw.js' /bin/sh -c 'pip install six'`,
    )
  })

  it('sets the run-as-Node switch with cmd syntax on Windows', () => {
    const winQuote = (v: string): string => `"${v.replace(/"/g, '""')}"`
    assert.equal(
      wrapWithPackageFirewall(
        'npm install',
        { path: 'cmd', cArg: '/c' },
        { execPath: 'C:\\Copse\\Copse.exe', scriptPath: 'C:\\Copse\\fw.js' },
        winQuote,
      ),
      `set "ELECTRON_RUN_AS_NODE=1" && "C:\\Copse\\Copse.exe" "C:\\Copse\\fw.js" cmd /c "npm install"`,
    )
  })
})
