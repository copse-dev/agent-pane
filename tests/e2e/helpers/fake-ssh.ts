import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { writeE2eEnv } from './e2e-env.ts'

const FAKE_SSH_DIR = join(process.cwd(), 'tests/e2e/fixtures/fake-ssh')

export interface FakeSshHostOptions {
  /**
   * Absolute directory the host reports as the remote account's home. It is
   * created empty and removed by `remove()`. Pick a fixed path when it shows in
   * a screenshot. Defaults to the local `$HOME`.
   */
  remoteHome?: string
}

export interface FakeSshHost {
  /** A scratch directory to use as the remote project root. */
  remoteRoot: string
  /** Make the host unreachable: the control master dies and new connections are refused. */
  takeDown: () => void
  /** Make the host reachable again. Nothing reconnects until the app asks. */
  bringUp: () => void
  /** Restore PATH and delete the scratch state. Call from `after`. */
  remove: () => void
}

/**
 * Give the app a reachable SSH host without an `sshd`.
 *
 * Puts the stub `ssh` in `tests/e2e/fixtures/fake-ssh/` first on the app's
 * PATH. Every saved host then "connects" to this machine, and remote commands
 * run in a local shell. This replaces the binary the app already shells out
 * to; it adds no option to the product. Call before `browser.reloadSession()`.
 */
export function installFakeSshHost(options: FakeSshHostOptions = {}): FakeSshHost {
  const originalPath = process.env['PATH'] ?? ''
  const stateDir = mkdtempSync(join(tmpdir(), 'copse-e2e-ssh-state-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-ssh-remote-'))
  writeFileSync(join(remoteRoot, 'README.md'), '# Remote project\n')
  const { remoteHome } = options
  if (remoteHome !== undefined) {
    rmSync(remoteHome, { recursive: true, force: true })
    mkdirSync(remoteHome, { recursive: true })
    writeFileSync(join(stateDir, 'home'), remoteHome)
  }
  writeE2eEnv({
    PATH: [FAKE_SSH_DIR, originalPath].join(delimiter),
    COPSE_E2E_FAKE_SSH_STATE: stateDir,
  })
  const hostDown = join(stateDir, 'host-down')
  return {
    remoteRoot,
    takeDown: (): void => {
      writeFileSync(hostDown, '')
    },
    bringUp: (): void => {
      rmSync(hostDown, { force: true })
    },
    remove: (): void => {
      writeE2eEnv({ PATH: originalPath, COPSE_E2E_FAKE_SSH_STATE: undefined })
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(remoteRoot, { recursive: true, force: true })
      if (remoteHome !== undefined) rmSync(remoteHome, { recursive: true, force: true })
    },
  }
}

export interface LocalSshConfig {
  /** Restore the app's real HOME and delete the scratch one. Call from `after`. */
  remove: () => void
}

/**
 * Give the app a `~/.ssh/config` the spec chooses, or an empty one.
 *
 * Copse reads `~/.ssh/config` to offer its hosts, so a spec that shows them
 * cannot depend on the runner's own file. This points the app's HOME at a
 * scratch directory holding `config` as `.ssh/config`, the same boundary the
 * app reads; nothing in the product knows. Call before `browser.reloadSession()`.
 */
export function useLocalSshConfig(config: string): LocalSshConfig {
  const originalHome = process.env['HOME']
  const home = mkdtempSync(join(tmpdir(), 'copse-e2e-home-'))
  mkdirSync(join(home, '.ssh'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, '.ssh', 'config'), config, { mode: 0o600 })
  writeE2eEnv({ HOME: home })
  return {
    remove: (): void => {
      writeE2eEnv({ HOME: originalHome })
      rmSync(home, { recursive: true, force: true })
    },
  }
}
