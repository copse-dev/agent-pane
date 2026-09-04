import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContainerRuntimeAttestation } from '@shared/types/unattended-run.ts'
import { isDeferredApprovalError } from '@shared/threads/deferred-approval.ts'
import { setApprovalHandler } from '../approval.ts'
import { runWithActiveRunIdentity, setActiveRunThread } from '../thread-models.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { setWorkspaceTrusted } from './workspace-trust.ts'
import { clearGitRemotesCache } from './git-remotes.ts'
import { ensureShellCommandPermitted } from './permission-gate.ts'
import { armGuardedYolo, disableGuardedYolo, getGuardedYoloState } from './guarded-yolo.ts'
import { clearDeferralModesForTests, isDeferralModeActive } from './deferral-mode.ts'
import { readPendingDeferrals } from './deferred-approval-store.ts'
import {
  clearRuntimeContainmentForTests,
  containerAttestationShortfall,
  declareContainerRuntime,
  parseContainerRuntimeAttestation,
  runtimeContainmentTier,
} from './runtime-containment.ts'
import {
  armUnattendedRun,
  clearUnattendedRunsForTests,
  currentRunIsUnattendedContainer,
  disarmUnattendedRun,
  getUnattendedRunState,
} from './unattended-run.ts'

const THREAD = 'unattended-run-test-thread'
const BUDGETS = { wallClockMs: 60_000, tokenCeiling: 100_000 }

function attestation(
  overrides: Partial<ContainerRuntimeAttestation> = {},
): ContainerRuntimeAttestation {
  return {
    runtimeId: 'rt-test',
    image: 'copse-worker:test',
    user: 1000,
    readOnlyRootfs: true,
    capDropAll: true,
    noNewPrivileges: true,
    pidsLimit: 256,
    memoryLimit: '2g',
    network: 'brokered',
    egressAllowlist: ['model.copse.internal:8080'],
    hostMounts: ['/run/copse'],
    ...overrides,
  }
}

const roots: string[] = []
let root = ''

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'copse-unattended-'))
  roots.push(root)
  mkdirSync(join(root, '.git'))
  writeFileSync(
    join(root, '.git', 'config'),
    '[remote "origin"]\n\turl = https://example.com/x.git\n',
  )
  process.env['COPSE_WORKSPACE_DIR'] = join(root, 'store')
  clearGitRemotesCache()
  setWorkspaceTrusted(root, true)
  await setSetting('safetyClassifierEnabled', false)
})

afterEach(() => {
  clearUnattendedRunsForTests()
  clearRuntimeContainmentForTests()
  clearDeferralModesForTests()
  disableGuardedYolo(THREAD)
  setApprovalHandler(null)
  setWorkspaceTrusted(root, false)
})

process.on('exit', () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** Run `fn` as the agent loop would, with THREAD's run active. */
function asRun<T>(fn: () => Promise<T>): Promise<T> {
  return runWithActiveRunIdentity(THREAD, () => {
    setActiveRunThread(THREAD)
    return fn()
  })
}

type Outcome = 'allowed' | 'prompted' | 'deferred' | 'blocked'

/** Drive the real gate and report which of the four things happened. */
async function gate(command: string): Promise<Outcome> {
  const seen = { prompted: false }
  setApprovalHandler(() => {
    seen.prompted = true
    return Promise.resolve({ approved: false, remember: false })
  })
  const restore = setWorkspaceRootForTest(root)
  try {
    const permitted = await asRun(() =>
      ensureShellCommandPermitted(command, {
        sandboxEnabled: false,
        autoRun: true,
        executionRoot: root,
      }),
    )
    if (seen.prompted) return 'prompted'
    return permitted ? 'allowed' : 'blocked'
  } catch (error) {
    if (isDeferredApprovalError(error)) return 'deferred'
    if (seen.prompted) return 'prompted'
    return 'blocked'
  } finally {
    restore()
  }
}

describe('runtime containment declaration', () => {
  it('reports the desktop tier until a container is declared', () => {
    assert.notEqual(runtimeContainmentTier(), 'container')
    declareContainerRuntime(attestation())
    assert.equal(runtimeContainmentTier(), 'container')
  })

  it('refuses an attestation that falls short of the bar', () => {
    assert.equal(containerAttestationShortfall(attestation()), null)
    for (const bad of [
      attestation({ user: 0 }),
      attestation({ readOnlyRootfs: false }),
      attestation({ capDropAll: false }),
      attestation({ noNewPrivileges: false }),
      attestation({ hostMounts: ['/run/copse', '/var/run/docker.sock'] }),
      attestation({ network: 'none', egressAllowlist: ['x:1'] }),
    ]) {
      assert.notEqual(containerAttestationShortfall(bad), null)
      assert.throws(() => {
        declareContainerRuntime(bad)
      })
      assert.notEqual(runtimeContainmentTier(), 'container')
    }
  })

  it('parses only a complete host-written record', () => {
    assert.deepEqual(parseContainerRuntimeAttestation(JSON.stringify(attestation())), attestation())
    assert.equal(parseContainerRuntimeAttestation('{"runtimeId":"x"}'), null)
    assert.equal(parseContainerRuntimeAttestation('not json'), null)
  })
})

describe('unattended-run ledger', () => {
  it('arming switches the thread into deferral mode; disarming switches it back', () => {
    assert.equal(isDeferralModeActive(THREAD), false)
    armUnattendedRun(THREAD, { runtimeId: 'rt', budgets: BUDGETS })
    assert.equal(isDeferralModeActive(THREAD), true)
    assert.equal(getUnattendedRunState(THREAD).phase, 'armed')
    disarmUnattendedRun(THREAD)
    assert.equal(isDeferralModeActive(THREAD), false)
    assert.equal(getUnattendedRunState(THREAD).phase, 'off')
  })

  it('is never active on the same thread as Guarded YOLO, in either order', () => {
    armGuardedYolo(THREAD)
    assert.throws(() => {
      armUnattendedRun(THREAD, { runtimeId: 'rt', budgets: BUDGETS })
    })
    assert.equal(getUnattendedRunState(THREAD).phase, 'off')
    disableGuardedYolo(THREAD)

    armUnattendedRun(THREAD, { runtimeId: 'rt', budgets: BUDGETS })
    assert.throws(() => {
      armGuardedYolo(THREAD)
    })
    assert.equal(getGuardedYoloState(THREAD).phase, 'off')
  })

  it('refuses a run without budgets', () => {
    assert.throws(() => {
      armUnattendedRun(THREAD, { runtimeId: 'rt', budgets: { wallClockMs: 0, tokenCeiling: 1 } })
    })
    assert.equal(isDeferralModeActive(THREAD), false)
  })

  it('offers the container rules only when both facts hold', async () => {
    assert.equal(currentRunIsUnattendedContainer(THREAD), false)
    armUnattendedRun(THREAD, { runtimeId: 'rt', budgets: BUDGETS })
    await asRun(async () => {
      // Armed, but on the desktop tier: the run is active and deferring, yet
      // the contained-effect rules are not offered.
      assert.equal(currentRunIsUnattendedContainer(THREAD), false)
    })
    declareContainerRuntime(attestation())
    await asRun(async () => {
      assert.equal(currentRunIsUnattendedContainer(THREAD), true)
    })
    disarmUnattendedRun(THREAD)
    assert.equal(currentRunIsUnattendedContainer(THREAD), false)
  })
})

describe('shell gate matrix: command class × containment tier × unattended', () => {
  const contained = 'rm -rf build node_modules'
  const install = 'pnpm install --frozen-lockfile'
  const outward = 'git push origin HEAD'
  const escape = 'docker ps'

  it('unattended on a container: contained runs, outward defers, escape is blocked', async () => {
    declareContainerRuntime(attestation())
    armUnattendedRun(THREAD, { runtimeId: 'rt', budgets: BUDGETS })

    assert.equal(await gate(contained), 'allowed')
    assert.equal(await gate(install), 'allowed')
    assert.equal(await gate(outward), 'deferred')
    assert.equal(await gate(escape), 'blocked')

    const queue = await readPendingDeferrals({ threadId: THREAD })
    assert.equal(queue.length, 1)
    assert.equal(queue[0]?.cause, 'shell-outward-effect')
  })

  it('unattended on the desktop tier keeps the desktop rules, only non-blocking', async () => {
    armUnattendedRun(THREAD, { runtimeId: 'rt', budgets: BUDGETS })
    // No containment: a destructive command still needs a human, and with
    // nobody there that is a deferral, never an auto-allow.
    assert.equal(await gate(contained), 'deferred')
    assert.equal(await gate(outward), 'deferred')
  })

  it('a container without an armed run prompts exactly as today', async () => {
    declareContainerRuntime(attestation())
    assert.equal(await gate(contained), 'prompted')
    assert.equal(await gate(outward), 'prompted')
  })

  it('a hard harm-gate deny stays a deny inside the container', async () => {
    declareContainerRuntime(attestation())
    armUnattendedRun(THREAD, { runtimeId: 'rt', budgets: BUDGETS })
    assert.equal(await gate(':(){ :|:& };:'), 'blocked')
    assert.equal(await gate('rm -rf /'), 'blocked')
  })
})
