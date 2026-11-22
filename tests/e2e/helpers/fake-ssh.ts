import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { writeE2eEnv } from './e2e-env.ts'

const FAKE_SSH_DIR = join(process.cwd(), 'tests/e2e/fixtures/fake-ssh')

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
export function installFakeSshHost(): FakeSshHost {
  const originalPath = process.env['PATH'] ?? ''
  const stateDir = mkdtempSync(join(tmpdir(), 'copse-e2e-ssh-state-'))
  const remoteRoot = mkdtempSync(join(tmpdir(), 'copse-e2e-ssh-remote-'))
  writeFileSync(join(remoteRoot, 'README.md'), '# Remote project\n')
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
    },
  }
}
