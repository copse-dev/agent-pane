import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  planRootUserns,
  ROOT_USERNS_ENV,
  type RootUsernsHost,
  type RootUsernsPlan,
} from './root-container-userns.mts'

function host(overrides: Partial<RootUsernsHost> = {}): RootUsernsHost {
  return {
    platform: 'linux',
    uid: 0,
    env: {},
    hasBinary: () => true,
    canUnshare: () => true,
    ...overrides,
  }
}

function blockedReason(plan: RootUsernsPlan): string {
  assert.equal(plan.kind, 'blocked')
  return plan.reason
}

const e2e = { requireSandbox: true }
const unit = { requireSandbox: false }

describe('planRootUserns', () => {
  it('re-executes root on Linux when the sandbox and user namespaces are available', () => {
    assert.deepEqual(planRootUserns(host(), e2e), { kind: 'reexec' })
    assert.deepEqual(planRootUserns(host(), unit), { kind: 'reexec' })
  })

  it('leaves non-root and non-Linux hosts alone without probing them', () => {
    const probes: string[] = []
    const probing = {
      hasBinary: (binary: string): boolean => (probes.push(binary), false),
      canUnshare: (): boolean => (probes.push('unshare'), false),
    }
    assert.deepEqual(planRootUserns(host({ uid: 1001, ...probing }), e2e), { kind: 'run-here' })
    assert.deepEqual(planRootUserns(host({ platform: 'darwin', ...probing }), e2e), {
      kind: 'run-here',
    })
    assert.deepEqual(probes, [])
  })

  it('runs in place inside the namespace and when the caller opts out', () => {
    assert.deepEqual(planRootUserns(host({ env: { [ROOT_USERNS_ENV]: '1' } }), e2e), {
      kind: 'run-here',
    })
    assert.deepEqual(
      planRootUserns(host({ env: { [ROOT_USERNS_ENV]: '0' }, hasBinary: () => false }), e2e),
      { kind: 'run-here' },
    )
  })

  it('stops e2e before any spec, naming each missing package', () => {
    assert.match(
      blockedReason(planRootUserns(host({ hasBinary: (binary) => binary !== 'socat' }), e2e)),
      /needs socat, which is not installed/,
    )
    assert.match(
      blockedReason(planRootUserns(host({ hasBinary: () => false }), e2e)),
      /needs bubblewrap and socat.*apt-get install -y --no-install-recommends bubblewrap socat/,
    )
  })

  it('stops e2e when no user namespace can be created', () => {
    assert.match(
      blockedReason(planRootUserns(host({ canUnshare: () => false }), e2e)),
      /unshare -U/,
    )
  })

  it('lets unit runs carry on as root when the sandbox cannot work', () => {
    assert.deepEqual(planRootUserns(host({ hasBinary: () => false }), unit), { kind: 'run-here' })
    assert.deepEqual(planRootUserns(host({ canUnshare: () => false }), unit), { kind: 'run-here' })
  })
})
