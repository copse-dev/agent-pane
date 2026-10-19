import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ClientCredentials } from './client-credentials.ts'
import { ClientPairings } from './client-pairings.ts'
import type { ClientAccess } from '../../../shared/client-auth.ts'

function consent(): {
  approve: (label: string, code: string, signal: AbortSignal) => Promise<ClientAccess | null>
  finish: (access: ClientAccess | null) => Promise<void>
  cancelled: () => boolean | undefined
} {
  let resolve: (access: ClientAccess | null) => void = () => {}
  const result = new Promise<ClientAccess | null>((done) => {
    resolve = done
  })
  let signal: AbortSignal | undefined
  return {
    approve: (
      _label: string,
      _code: string,
      current: AbortSignal,
    ): Promise<ClientAccess | null> => {
      signal = current
      return result
    },
    finish: async (access: ClientAccess | null): Promise<void> => {
      resolve(access)
      await result
      await Promise.resolve()
    },
    cancelled: (): boolean | undefined => signal?.aborted,
  }
}

describe('shared desktop-consent pairing', () => {
  for (const transport of ['mobile', 'plugin'] as const) {
    it(`${transport}: issues only the consented grant and delivers it once to the requesting binding`, async () => {
      const credentials = new ClientCredentials()
      const prompt = consent()
      const pairing = new ClientPairings({
        maxPending: transport === 'mobile' ? 1 : 4,
        issue: (label, access, binding): { id: string; token: string } =>
          credentials.issue(label, access, transport === 'mobile' ? undefined : binding),
        revoke: (id): void => {
          credentials.revoke(id)
        },
        approve: prompt.approve,
      })
      try {
        const binding = transport === 'mobile' ? '192.168.1.55' : 'http://127.0.0.1:17341'
        const request = pairing.request('Client', binding)
        assert.ok(request)
        assert.match(request.code, /^\d{6}$/)
        assert.deepEqual(pairing.poll(request.id, binding), { state: 'pending' })
        assert.equal(credentials.list().length, 0)
        assert.equal(pairing.request('Flood', binding), null)
        await prompt.finish('read')
        assert.equal(pairing.poll(request.id, 'different binding'), null)
        const result = pairing.poll(request.id, binding)
        assert.equal(result?.state, 'approved')
        const header = `Bearer ${result.token}`
        const tokenBinding = transport === 'mobile' ? undefined : binding
        assert.equal(credentials.principal(header, tokenBinding)?.access, 'read')
        assert.equal(credentials.principal(header, tokenBinding, 'control'), null)
        assert.equal(pairing.poll(request.id, binding), null)
        pairing.close()
        assert.equal(
          credentials.principal(header, tokenBinding)?.access,
          'read',
          'closing pairing leaves delivered credentials to the transport lifetime policy',
        )
      } finally {
        pairing.close()
      }
    })
  }

  it('expires consent, clears its UI signal and rejects late approval even if the callback ignores cancellation', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    const prompt = consent()
    const credentials = new ClientCredentials()
    const pairings = new ClientPairings({
      maxPending: 1,
      issue: (label, access): { id: string; token: string } => credentials.issue(label, access),
      revoke: (id): void => {
        credentials.revoke(id)
      },
      approve: prompt.approve,
    })
    try {
      const request = pairings.request('Phone')
      assert.ok(request)
      t.mock.timers.tick(120_000)
      assert.equal(prompt.cancelled(), true)
      await prompt.finish('control')
      assert.equal(pairings.poll(request.id), null)
      assert.equal(credentials.list().length, 0)
    } finally {
      pairings.close()
    }
  })

  it('bounds concurrent requests and rechecks capacity after asynchronous desktop consent', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    const credentials = new ClientCredentials()
    const prompt = consent()
    const pairings = new ClientPairings({
      maxPending: 2,
      canIssue: (): boolean => credentials.list().length < 1,
      issue: (label, access): { id: string; token: string } => credentials.issue(label, access),
      revoke: (id): void => {
        credentials.revoke(id)
      },
      approve: prompt.approve,
    })
    try {
      const first = pairings.request('First')
      assert.ok(first)
      t.mock.timers.tick(1000)
      const second = pairings.request('Second')
      assert.ok(second)
      t.mock.timers.tick(1000)
      assert.equal(pairings.request('Third'), null)
      await prompt.finish('control')
      assert.equal(credentials.list().length, 1)
      assert.equal(pairings.poll(first.id)?.state, 'approved')
      assert.deepEqual(pairings.poll(second.id), { state: 'denied' })
    } finally {
      pairings.close()
    }
  })

  it('revokes uncollected credentials on expiry or stop, and never issues after shutdown', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 })
    for (const stage of ['pending-stop', 'approved-stop', 'approved-expire'] as const) {
      const credentials = new ClientCredentials()
      const prompt = consent()
      const pairings = new ClientPairings({
        maxPending: 1,
        issue: (label, access): { id: string; token: string } => credentials.issue(label, access),
        revoke: (id): void => {
          credentials.revoke(id)
        },
        approve: prompt.approve,
      })
      const request = pairings.request('Client')
      assert.ok(request)
      if (stage !== 'pending-stop') {
        await prompt.finish('control')
        assert.equal(credentials.list().length, 1)
      }
      if (stage === 'approved-expire') t.mock.timers.tick(120_000)
      else pairings.close()
      if (stage === 'pending-stop') await prompt.finish('control')
      assert.equal(pairings.poll(request.id), null)
      assert.equal(credentials.list().length, 0)
      pairings.close()
      assert.equal(pairings.request('Late request'), null)
    }
  })

  it('returns denied exactly once for explicit denial or a failed consent callback', async () => {
    for (const fail of [false, true]) {
      const pairings = new ClientPairings({
        maxPending: 1,
        issue: (): never => assert.fail('Denied consent issued a token'),
        revoke: (): void => {},
        approve: async (): Promise<ClientAccess | null> => {
          if (fail) throw new Error('Closed dialog')
          return null
        },
      })
      try {
        const request = pairings.request('Client')
        assert.ok(request)
        await Promise.resolve()
        await Promise.resolve()
        assert.deepEqual(pairings.poll(request.id), { state: 'denied' })
        assert.equal(pairings.poll(request.id), null)
      } finally {
        pairings.close()
      }
    }
  })

  it('finishes shutdown even if persisting an uncollected credential revocation fails', async (t) => {
    let writable = true
    const errors = t.mock.method(console, 'error', () => {})
    const credentials = new ClientCredentials([], () => {
      if (!writable) throw new Error('Disk unavailable')
    })
    const prompt = consent()
    const pairings = new ClientPairings({
      maxPending: 1,
      issue: (label, access): { id: string; token: string } => credentials.issue(label, access),
      revoke: (id): void => {
        credentials.revoke(id)
      },
      approve: prompt.approve,
    })
    const request = pairings.request('Phone')
    assert.ok(request)
    await prompt.finish('control')
    assert.equal(credentials.list().length, 1)
    writable = false
    assert.doesNotThrow(() => {
      pairings.close()
    })
    assert.equal(credentials.list().length, 0)
    assert.equal(pairings.poll(request.id), null)
    assert.equal(prompt.cancelled(), true)
    assert.equal(errors.mock.callCount(), 1)
  })
})
