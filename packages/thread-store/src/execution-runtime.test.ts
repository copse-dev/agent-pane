import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  automationPrincipal,
  deriveRuntimeCapabilities,
  humanPrincipal,
  LOCAL_HUMAN_PRINCIPAL_ID,
  parseExecutionRuntimeCapabilities,
  runtimeProfileId,
  type ExecutionRuntimeCapabilities,
  type RuntimeProfile,
} from './execution-runtime.ts'

describe('deriveRuntimeCapabilities', () => {
  // The capability matrix: each profile reports what is enforced today, one
  // property at a time. SSH never inherits the local sandbox.
  const rows: [RuntimeProfile, ExecutionRuntimeCapabilities][] = [
    [
      { kind: 'local', containment: 'contained' },
      {
        filesystem: 'workspace',
        processIsolation: 'os-sandbox',
        network: 'global-allowlist',
        secrets: 'raw-env',
        checkpoint: 'none',
        suspendResume: false,
      },
    ],
    [
      { kind: 'local', containment: 'host' },
      {
        filesystem: 'host',
        processIsolation: 'none',
        network: 'unrestricted',
        secrets: 'raw-env',
        checkpoint: 'none',
        suspendResume: false,
      },
    ],
    [
      { kind: 'ssh', hostId: 'build-box' },
      {
        filesystem: 'remote-account',
        processIsolation: 'none',
        network: 'unrestricted',
        secrets: 'raw-env',
        checkpoint: 'none',
        suspendResume: false,
      },
    ],
  ]

  for (const [profile, expected] of rows) {
    it(`reports ${runtimeProfileId(profile)} honestly`, () => {
      assert.deepEqual(deriveRuntimeCapabilities(profile), expected)
    })
  }

  it('has no single sandboxed flag', () => {
    const keys = Object.keys(deriveRuntimeCapabilities({ kind: 'local', containment: 'contained' }))
    assert.equal(keys.includes('sandboxed'), false)
  })

  it('lists brokered credential families without upgrading the other secrets', () => {
    const capabilities = deriveRuntimeCapabilities(
      { kind: 'local', containment: 'host' },
      { brokeredCredentials: ['github'] },
    )
    assert.deepEqual(capabilities.brokeredCredentials, ['github'])
    assert.equal(capabilities.secrets, 'raw-env')
  })

  it('round-trips through the validator and rejects unknown values', () => {
    const capabilities = deriveRuntimeCapabilities({ kind: 'ssh', hostId: 'h' })
    assert.deepEqual(
      parseExecutionRuntimeCapabilities(JSON.parse(JSON.stringify(capabilities))),
      capabilities,
    )
    assert.equal(parseExecutionRuntimeCapabilities({ ...capabilities, network: 'any' }), null)
    assert.equal(parseExecutionRuntimeCapabilities(null), null)
  })
})

describe('runtimeProfileId', () => {
  it('names local profiles by containment and SSH by host', () => {
    assert.equal(runtimeProfileId({ kind: 'local', containment: 'contained' }), 'local/contained')
    assert.equal(runtimeProfileId({ kind: 'local', containment: 'host' }), 'local/host')
    assert.equal(runtimeProfileId({ kind: 'ssh', hostId: 'h1' }), 'ssh:h1')
  })
})

describe('principals', () => {
  it('binds the human principal to the project', () => {
    assert.deepEqual(humanPrincipal('p'), {
      id: LOCAL_HUMAN_PRINCIPAL_ID,
      kind: 'human',
      projectId: 'p',
    })
  })

  it('gives each automation run its own principal id', () => {
    const first = automationPrincipal('p', 'nightly', 100)
    const next = automationPrincipal('p', 'nightly', 200)
    assert.equal(first.kind, 'automation')
    assert.equal(first.workflowId, 'nightly')
    assert.notEqual(first.id, next.id)
  })
})
