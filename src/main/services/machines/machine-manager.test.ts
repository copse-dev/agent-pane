import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  classify,
  CLASSIFIER_TEST_REQUEST,
  type ClassifierProfile,
} from '@copse/llm/classifiers/index.ts'
import { createKeyringCipher } from '../storage/keyring-cipher.ts'
import { isSecretSettingKey } from '../storage/settings-writable.ts'
import { MachineManager } from './machine-manager.ts'
import { machineStoreSchema, type MachineStore, type MachineStoreData } from './machine-store.ts'
import { decodeMachineInvitation, machineRequest } from './machine-transport.ts'

function storage(): MachineStore {
  let value: MachineStoreData | null = null
  let key: string | null = null
  const cipher = createKeyringCipher({
    read: () => key,
    write: (next) => {
      key = next
    },
  })
  return {
    enabled: () => true,
    load: () => (value ? machineStoreSchema.parse(structuredClone(value)) : null),
    save: async (next): Promise<void> => {
      value = machineStoreSchema.parse(structuredClone(next))
    },
    seal: (plain) => cipher.encryptString(plain).toString('base64'),
    open: (encrypted) => cipher.decryptString(Buffer.from(encrypted, 'base64')),
    available: () => true,
  }
}

test('paired machines route native calls, preserve pins across restart, recover, and revoke per client', async () => {
  let calls = 0
  const native = createServer((request, response) => {
    assert.equal(request.url, '/v1/systemone')
    request.resume()
    calls++
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        model: 'kev-fixture',
        answers: {
          color: {
            type: 'choice',
            choice: 'red',
            probabilities: { red: 0.9, blue: 0.1 },
            confidence: 0.7,
          },
        },
      }),
    )
  })
  await new Promise<void>((resolve) => native.listen(0, '127.0.0.1', resolve))
  const address = native.address()
  assert.ok(address && typeof address !== 'string')
  const profile: ClassifierProfile = {
    id: 'kev',
    label: 'Local Kev',
    model: 'kev-local',
    timeoutMs: 5000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      auth: 'none',
    },
  }
  const hostStore = storage(),
    clientStore = storage(),
    otherStore = storage()
  const makeHost = (): MachineManager =>
    new MachineManager(
      hostStore,
      () => [profile],
      async (_id, request, signal) => classify(profile, request, { signal }),
      'Model computer',
    )
  let host = makeHost()
  let client = new MachineManager(
    clientStore,
    () => [],
    async () => {
      throw new Error('No shared models')
    },
    'Work computer',
  )
  const other = new MachineManager(
    otherStore,
    () => [],
    async () => {
      throw new Error('No shared models')
    },
  )
  try {
    const sharing = await host.share({
      enabled: true,
      address: '127.0.0.1',
      port: 0,
      profileIds: ['kev'],
    })
    assert.equal(sharing.sharing.listening, true)
    const invitation = host.invitation()
    const paired = await client.pair(invitation)
    const peer = paired.machines[0]
    assert.ok(peer)
    assert.equal(peer.name, 'Model computer')
    assert.equal(peer.status, 'connected')
    assert.equal(calls, 0)
    assert.equal(host.snapshot().clients[0]?.name, 'Work computer')
    // Retrying after a lost pairing acknowledgement recovers this same client.
    await client.pair(invitation)
    await assert.rejects(other.pair(invitation))
    const signal = new AbortController().signal
    const result = z
      .object({
        answers: z.object({
          color: z.object({
            probabilities: z.record(z.string(), z.number()),
            confidence: z.number(),
          }),
        }),
      })
      .parse(await client.call(peer.id, 'kev', CLASSIFIER_TEST_REQUEST, signal, 5000))
    assert.deepEqual(result.answers.color.probabilities, { red: 0.9, blue: 0.1 })
    assert.equal(result.answers.color.confidence, 0.7)
    assert.equal(calls, 1)
    await assert.rejects(client.call(peer.id, 'not-shared', CLASSIFIER_TEST_REQUEST, signal, 5000))
    assert.equal(calls, 1)
    const saved = clientStore.load()
    assert.ok(saved)
    const storedPeer = saved.machines[0]
    assert.ok(storedPeer)
    assert.ok(!JSON.stringify(saved).includes(clientStore.open(storedPeer.token)))
    const storedHost = hostStore.load()
    assert.ok(storedHost?.identity)
    assert.ok(!JSON.stringify(storedHost).includes('PRIVATE KEY'))
    await host.close()
    await client.refresh()
    assert.equal(client.snapshot().machines[0]?.status, 'reconnecting')
    assert.equal(calls, 1)
    host = makeHost()
    await host.restore()
    client = new MachineManager(
      clientStore,
      () => [],
      async () => {
        throw new Error('No shared models')
      },
    )
    await client.refresh()
    assert.equal(client.snapshot().machines[0]?.status, 'connected')
    assert.equal(calls, 1)
    await client.call(peer.id, 'kev', CLASSIFIER_TEST_REQUEST, signal, 5000)
    assert.equal(calls, 2)
    const clientId = host.snapshot().clients[0]?.id
    assert.ok(clientId)
    await host.revoke(clientId)
    await client.refresh()
    assert.equal(client.snapshot().machines[0]?.status, 'unavailable')
    await assert.rejects(client.call(peer.id, 'kev', CLASSIFIER_TEST_REQUEST, signal, 5000))
    assert.equal(calls, 2)
    await host.share({
      enabled: false,
      address: '127.0.0.1',
      port: sharing.sharing.port,
      profileIds: ['kev'],
    })
  } finally {
    await Promise.all([host.close(), client.close(), other.close()])
    await new Promise<void>((resolve) =>
      native.close(() => {
        resolve()
      }),
    )
  }
})

test('machine sharing refuses plaintext credentials, unsafe or expired invitations, hosted models, and task RPCs', async (t) => {
  const unavailable = storage()
  unavailable.available = (): boolean => false
  const blocked = new MachineManager(
    unavailable,
    () => [],
    async () => {
      throw new Error('Unexpected call')
    },
  )
  await assert.rejects(blocked.pair('invalid'), /secure storage/)
  await assert.rejects(
    blocked.share({ enabled: true, address: '127.0.0.1', port: 0, profileIds: ['model'] }),
    /secure storage/,
  )
  assert.throws(() => decodeMachineInvitation('invalid'))
  assert.throws(() =>
    decodeMachineInvitation(
      'copse-machine1-' +
        Buffer.from(
          JSON.stringify({
            version: 1,
            address: '8.8.8.8',
            port: 443,
            fingerprint: 'AA:'.repeat(31) + 'AA',
            secret: 'a'.repeat(64),
          }),
        ).toString('base64url'),
    ),
  )
  assert.equal(isSecretSettingKey('machineConnections'), true)
  assert.equal(isSecretSettingKey('machineConnections.clients'), true)
  const profile: ClassifierProfile = {
    id: 'local',
    label: 'Local',
    model: 'kev',
    timeoutMs: 1000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: 'http://127.0.0.1:1/v1',
      auth: 'none',
    },
  }
  const store = storage()
  const host = new MachineManager(
    store,
    () => [
      profile,
      {
        ...profile,
        id: 'hosted',
        connection: {
          type: 'http',
          protocol: 'systemone',
          baseUrl: 'https://example.com/v1',
          auth: 'none',
        },
      },
    ],
    async () => {
      throw new Error('No inference expected')
    },
  )
  try {
    assert.deepEqual(
      host.shareable().map((item) => item.id),
      ['local'],
    )
    await assert.rejects(
      host.share({ enabled: true, address: '127.0.0.1', port: 0, profileIds: ['hosted'] }),
      /local System One/,
    )
    await host.share({ enabled: true, address: '127.0.0.1', port: 0, profileIds: ['local'] })
    const invitation = decodeMachineInvitation(host.invitation())
    await assert.rejects(
      machineRequest({ ...invitation, fingerprint: '00:'.repeat(31) + '00' }, '/pair', {
        secret: invitation.secret,
        id: randomUUID(),
        name: 'Client',
      }),
      /identity changed/,
    )
    assert.equal(host.snapshot().clients.length, 0)
    const paired = z.object({ token: z.string() }).parse(
      await machineRequest(invitation, '/pair', {
        secret: invitation.secret,
        id: randomUUID(),
        name: 'Client',
      }),
    )
    await assert.rejects(
      machineRequest(
        invitation,
        '/models',
        { method: 'tasks.start', prompt: 'run shell' },
        { token: paired.token },
      ),
    )
    const expired = decodeMachineInvitation(host.invitation())
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 600_001 })
    await assert.rejects(
      machineRequest(expired, '/pair', {
        secret: expired.secret,
        id: randomUUID(),
        name: 'Late client',
      }),
    )
    assert.equal(host.snapshot().clients.length, 1, 'expired invitations grant no access')
  } finally {
    await host.close()
  }
})

test(
  'cancellation, disconnect and revocation stop active remote inference',
  { timeout: 10_000 },
  async () => {
    const profile: ClassifierProfile = {
      id: 'slow',
      label: 'Slow local model',
      model: 'fixture',
      timeoutMs: 5000,
      connection: {
        type: 'http',
        protocol: 'systemone',
        baseUrl: 'http://127.0.0.1:1/v1',
        auth: 'none',
      },
    }
    let started = Promise.withResolvers<undefined>()
    let aborted = Promise.withResolvers<undefined>()
    const hostStore = storage()
    const clientStore = storage()
    const host = new MachineManager(
      hostStore,
      () => [profile],
      async (_id, _request, signal) => {
        started.resolve(undefined)
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted.resolve(undefined)
              reject(new Error('Cancelled fixture inference'))
            },
            { once: true },
          )
        })
      },
    )
    const client = new MachineManager(
      clientStore,
      () => [],
      async () => {
        throw new Error('No shared models')
      },
    )
    try {
      await host.share({ enabled: true, address: '127.0.0.1', port: 0, profileIds: ['slow'] })
      for (const stop of ['cancel', 'disconnect', 'revoke', 'disable-client', 'disable-host']) {
        hostStore.enabled = (): boolean => true
        clientStore.enabled = (): boolean => true
        await host.restore()
        started = Promise.withResolvers<undefined>()
        aborted = Promise.withResolvers<undefined>()
        const peer = (await client.pair(host.invitation())).machines[0]
        assert.ok(peer)
        const controller = new AbortController()
        const rejected = assert.rejects(
          client.call(peer.id, 'slow', CLASSIFIER_TEST_REQUEST, controller.signal, 5000),
        )
        await started.promise
        if (stop === 'cancel') controller.abort()
        else if (stop === 'disconnect') await client.remove(peer.id)
        else if (stop === 'disable-client') {
          clientStore.enabled = (): boolean => false
          await client.restore()
        } else if (stop === 'disable-host') {
          hostStore.enabled = (): boolean => false
          await host.restore()
        } else {
          const allowed = host.snapshot().clients[0]
          assert.ok(allowed)
          await host.revoke(allowed.id)
        }
        await rejected
        await aborted.promise
      }
    } finally {
      await Promise.all([host.close(), client.close()])
    }
  },
)

test('the experimental gate blocks networking and restores saved pairings without preventing cleanup', async () => {
  const hostStore = storage(),
    clientStore = storage()
  let hostEnabled = false,
    clientEnabled = false,
    calls = 0
  hostStore.enabled = (): boolean => hostEnabled
  clientStore.enabled = (): boolean => clientEnabled
  const profile: ClassifierProfile = {
    id: 'fixture',
    label: 'Local fixture',
    model: 'fixture',
    timeoutMs: 5000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: 'http://127.0.0.1:1/v1',
      auth: 'none',
    },
  }
  const makeHost = (): MachineManager =>
    new MachineManager(
      hostStore,
      () => [profile],
      async () => {
        calls++
        return {
          profileId: profile.id,
          adapter: 'systemone',
          requestedModel: profile.model,
          model: profile.model,
          elapsedMs: 0,
          answers: {},
        }
      },
    )
  let host = makeHost()
  const client = new MachineManager(
    clientStore,
    () => [],
    async () => {
      throw new Error('No shared models')
    },
  )
  const config = { enabled: true, address: '127.0.0.1', port: 0, profileIds: [profile.id] }
  const signal = new AbortController().signal
  try {
    await host.restore()
    assert.equal(host.snapshot().featureEnabled, false)
    assert.equal(host.snapshot().sharing.listening, false)
    await assert.rejects(host.share(config), /Enable Remote System One/)
    await assert.rejects(client.pair('invalid'), /Enable Remote System One/)
    assert.throws(() => host.invitation(), /Enable Remote System One/)
    hostEnabled = true
    await host.share(config)
    const invitation = host.invitation()
    await assert.rejects(client.pair(invitation), /Enable Remote System One/)
    assert.equal(host.snapshot().clients.length, 0)
    clientEnabled = true
    const peer = (await client.pair(invitation)).machines[0]
    assert.ok(peer)
    const allowed = host.snapshot().clients[0]
    assert.ok(allowed)
    await client.call(peer.id, profile.id, CLASSIFIER_TEST_REQUEST, signal, 5000)
    assert.equal(calls, 1)
    const queuedPair = client.pair(invitation)
    clientEnabled = false
    await assert.rejects(queuedPair, /Enable Remote System One/)
    await client.restore()
    await client.refresh()
    assert.equal(client.snapshot().machines[0]?.status, 'unavailable')
    await assert.rejects(
      client.call(peer.id, profile.id, CLASSIFIER_TEST_REQUEST, signal, 5000),
      /Enable Remote System One/,
    )
    assert.throws(() => client.model(peer.id, profile.id), /Enable Remote System One/)
    hostEnabled = false
    await host.restore()
    assert.equal(host.snapshot().sharing.listening, false)
    assert.equal(hostStore.load()?.sharing.enabled, true, 'retain the sharing preference')
    host = makeHost()
    await host.restore()
    assert.equal(host.snapshot().sharing.listening, false, 'restart cannot bypass the gate')
    assert.equal(host.snapshot().clients.length, 1)
    hostEnabled = true
    clientEnabled = true
    await host.restore()
    await client.call(peer.id, profile.id, CLASSIFIER_TEST_REQUEST, signal, 5000)
    assert.equal(calls, 2)
    hostEnabled = false
    clientEnabled = false
    await Promise.all([host.restore(), client.restore()])
    await client.remove(peer.id)
    await host.revoke(allowed.id)
    assert.equal(client.snapshot().machines.length, 0)
    assert.equal(host.snapshot().clients.length, 0)
  } finally {
    await Promise.all([host.close(), client.close()])
  }
})
