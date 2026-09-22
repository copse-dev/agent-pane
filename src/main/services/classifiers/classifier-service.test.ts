import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  CLASSIFIER_PRESETS,
  CLASSIFIER_TEST_REQUEST,
  classifierCredentialId,
} from '@copse/llm/classifiers/presets.ts'
import type { ClassifierProfile } from '@copse/llm/classifiers/types.ts'
import { setApprovalHandler } from '../approval.ts'
import { deleteApiKey, getApiKey, getSetting, setApiKey, setSetting } from '../storage/settings.ts'
import { runWithExplicitSettings } from '../storage/settings-context.ts'
import {
  getClassifierProfile,
  createClassifierSession,
  invokeClassifierBatch,
  listClassifierProfiles,
  removeClassifierProfile,
  saveClassifierProfile,
  testClassifierProfile,
} from './classifier-service.ts'

function preset(id: string): ClassifierProfile {
  const profile = CLASSIFIER_PRESETS.find((entry) => entry.id === id)
  assert.ok(profile)
  return profile
}

function response(): Response {
  return Response.json({
    model: 'fixture-v1',
    answers: { color: { type: 'choice', choice: 'red', probabilities: { red: 0.9, blue: 0.1 } } },
  })
}

describe('configured classifiers', () => {
  beforeEach(async () => {
    await setSetting('classifierProviders', { version: 1, profiles: [] })
    await setSetting('extraProviders', [])
    await setSetting('approvedProviderHosts', [])
    await setSetting('providerAllowUserApproval', true)
    for (const profile of CLASSIFIER_PRESETS) deleteApiKey(classifierCredentialId(profile.id))
    deleteApiKey('openai')
  })

  afterEach(() => {
    mock.restoreAll()
    setApprovalHandler(null)
    delete process.env['COPSE_CLASSIFIER_TEST_KEY']
    deleteApiKey('openai')
  })

  it('starts empty and preserves concurrent profile saves without changing active models', async () => {
    await setSetting('selectedModel', 'existing-chat-model')
    assert.deepEqual(listClassifierProfiles(), [])
    await Promise.all([
      saveClassifierProfile(preset('kev')),
      saveClassifierProfile(preset('typesafe')),
    ])
    assert.deepEqual(
      listClassifierProfiles()
        .map(({ profile }) => profile.id)
        .sort(),
      ['kev', 'typesafe'],
    )
    assert.equal(getSetting('selectedModel', ''), 'existing-chat-model')
    await saveClassifierProfile({ ...preset('kev'), label: 'My Kev' })
    assert.equal(getClassifierProfile('kev').label, 'My Kev')
    assert.equal(listClassifierProfiles().length, 2)
  })

  it('ignores corrupt/unknown-version configuration and rejects invalid profiles', async () => {
    await setSetting('classifierProviders', { version: 2, profiles: [preset('kev')] })
    assert.deepEqual(listClassifierProfiles(), [])
    await assert.rejects(saveClassifierProfile({ ...preset('kev'), id: '../openai' }))
    assert.throws(() => getClassifierProfile('kev'), /not configured/)
    assert.throws(() => getClassifierProfile('../openai'), /Invalid classifier/)
  })

  it('rejects legacy chat-provider key collisions for saves, calls and removal', async () => {
    await setSetting('extraProviders', [
      { slug: 'classifier-kev', baseUrl: 'http://127.0.0.1:1234/v1' },
    ])
    setApiKey('classifier-kev', 'legacy-chat-secret')
    await assert.rejects(saveClassifierProfile(preset('kev')), /conflicts/)
    await setSetting('classifierProviders', { version: 1, profiles: [preset('kev')] })
    await assert.rejects(testClassifierProfile('kev'), /conflicts/)
    await assert.rejects(removeClassifierProfile('kev'), /conflicts/)
    assert.equal(getApiKey('classifier-kev'), 'legacy-chat-secret')
  })

  it('preserves keys for model edits but clears them before a destination or auth change', async () => {
    const profile: ClassifierProfile = {
      ...preset('typesafe'),
      connection: {
        type: 'http',
        protocol: 'systemone',
        auth: 'bearer',
        baseUrl: 'https://api.typesafe.ai/v1',
      },
    }
    await saveClassifierProfile(profile)
    setApiKey('classifier-typesafe', 'vendor-secret')
    await saveClassifierProfile({ ...profile, model: 'new-model' })
    assert.equal(getApiKey('classifier-typesafe'), 'vendor-secret')
    await saveClassifierProfile({
      ...profile,
      connection: {
        type: 'http',
        protocol: 'systemone',
        auth: 'bearer',
        baseUrl: 'http://127.0.0.1:8009/v1',
      },
    })
    assert.equal(getApiKey('classifier-typesafe'), null)
    await assert.rejects(testClassifierProfile('typesafe'), { code: 'authentication' })
    setApiKey('classifier-typesafe', 'replacement-secret')
    await saveClassifierProfile({
      ...profile,
      connection: {
        type: 'http',
        protocol: 'systemone',
        auth: 'none',
        baseUrl: 'http://127.0.0.1:8009/v1',
      },
    })
    assert.equal(getApiKey('classifier-typesafe'), null)
  })

  it('requires custom-host approval before saving and rechecks policy when calling', async () => {
    const profile: ClassifierProfile = {
      ...preset('kev'),
      connection: {
        type: 'http',
        protocol: 'systemone',
        auth: 'none',
        baseUrl: 'https://classifier.example/v1',
      },
    }
    setApprovalHandler(async () => ({ approved: false, remember: false }))
    await assert.rejects(saveClassifierProfile(profile), /not approved/)
    assert.deepEqual(listClassifierProfiles(), [])
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    await saveClassifierProfile(profile)
    await setSetting('approvedProviderHosts', [])
    const fetchMock = mock.method(globalThis, 'fetch', async () => response())
    await assert.rejects(testClassifierProfile(profile.id), /not approved/)
    assert.equal(fetchMock.mock.callCount(), 0)
  })

  it('lists only key status, prefers saved credentials and deletes the scoped credential', async () => {
    const profile: ClassifierProfile = {
      ...preset('typesafe'),
      connection: {
        type: 'http',
        protocol: 'systemone',
        auth: 'bearer',
        baseUrl: 'https://api.typesafe.ai/v1',
        apiKeyEnv: 'COPSE_CLASSIFIER_TEST_KEY',
      },
    }
    process.env['COPSE_CLASSIFIER_TEST_KEY'] = 'environment-secret'
    await saveClassifierProfile(profile)
    setApiKey(classifierCredentialId(profile.id), 'stored-secret')
    setApiKey('openai', 'unrelated-secret')
    const statuses = listClassifierProfiles()
    assert.equal(statuses[0]?.hasKey, true)
    assert.equal(statuses[0].encrypted, true)
    assert.equal(JSON.stringify(statuses).includes('stored-secret'), false)
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer stored-secret')
      return response()
    })
    assert.equal((await testClassifierProfile(profile.id)).model, 'fixture-v1')
    await removeClassifierProfile(profile.id)
    assert.equal(getApiKey(classifierCredentialId(profile.id)), null)
    assert.equal(getApiKey('openai'), 'unrelated-secret')
    assert.deepEqual(listClassifierProfiles(), [])
  })

  it('uses an explicit environment key fallback but never inherits it into isolated profiles', async () => {
    const profile: ClassifierProfile = {
      ...preset('typesafe'),
      connection: {
        type: 'http',
        protocol: 'systemone',
        auth: 'bearer',
        baseUrl: 'https://api.typesafe.ai/v1',
        apiKeyEnv: 'COPSE_CLASSIFIER_TEST_KEY',
      },
    }
    process.env['COPSE_CLASSIFIER_TEST_KEY'] = '  environment-secret\n'
    await saveClassifierProfile(profile)
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async (_url: string | URL | Request, init?: RequestInit) => {
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer environment-secret')
        return response()
      },
    )
    await testClassifierProfile(profile.id)
    assert.equal(fetchMock.mock.callCount(), 1)
    await runWithExplicitSettings(
      { values: { classifierProviders: { version: 1, profiles: [profile] } } },
      async () => {
        assert.equal(listClassifierProfiles()[0]?.hasKey, false)
        await assert.rejects(testClassifierProfile(profile.id), { code: 'authentication' })
      },
    )
    assert.equal(fetchMock.mock.callCount(), 1)
  })

  it('rejects unrelated environment secrets and binds preset variables to their official endpoints', async () => {
    const invalidConnections = [
      {
        apiKeyEnv: 'AWS_SECRET_ACCESS_KEY',
        baseUrl: 'https://api.typesafe.ai/v1',
        protocol: 'systemone',
      },
      {
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        baseUrl: 'https://api.typesafe.ai/v1',
        protocol: 'systemone',
      },
      {
        apiKeyEnv: 'TYPESAFE_API_KEY',
        baseUrl: 'https://api.featherless.ai/v1',
        protocol: 'systemone',
      },
      {
        apiKeyEnv: 'TYPESAFE_API_KEY',
        baseUrl: 'https://api.typesafe.ai/collector',
        protocol: 'systemone',
      },
      { apiKeyEnv: 'TYPESAFE_API_KEY', baseUrl: 'http://127.0.0.1:8009/v1', protocol: 'systemone' },
    ]
    const fetchMock = mock.method(globalThis, 'fetch', async () => response())
    for (const connection of invalidConnections) {
      const profile: ClassifierProfile = {
        ...preset('typesafe'),
        connection: {
          type: 'http',
          auth: 'bearer',
          protocol: 'systemone',
          baseUrl: connection.baseUrl,
          apiKeyEnv: connection.apiKeyEnv,
        },
      }
      await assert.rejects(saveClassifierProfile(profile), /environment variable is not allowed/)
      // Also guard settings written by an older version, not only today's save API.
      await setSetting('classifierProviders', { version: 1, profiles: [profile] })
      await assert.rejects(testClassifierProfile(profile.id), /environment variable is not allowed/)
      assert.equal(listClassifierProfiles().length, 1, 'invalid legacy entries remain editable')
    }
    assert.equal(fetchMock.mock.callCount(), 0)
    await saveClassifierProfile(preset('typesafe'))
    await saveClassifierProfile(preset('featherless'))
  })

  it('resolves keys once per eval session while fresh sessions observe updated credentials', async () => {
    const profile = preset('typesafe')
    const keys: Record<string, string> = {
      'classifier-typesafe': 'first-classifier-key',
      openai: 'snapshot-chat-key',
    }
    let reads = 0
    const apiKeys = new Proxy(keys, {
      get(target, property, receiver): unknown {
        reads++
        return Reflect.get(target, property, receiver)
      },
    })
    const authorization: (string | null)[] = []
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      authorization.push(new Headers(init?.headers).get('Authorization'))
      const body = init?.body
      assert.equal(typeof body, 'string')
      if (typeof body !== 'string') assert.fail('Expected JSON request body')
      assert.equal(body.includes('snapshot-chat-key'), false)
      return response()
    })
    await runWithExplicitSettings(
      { values: { classifierProviders: { version: 1, profiles: [profile] } }, apiKeys },
      async () => {
        const session = createClassifierSession('typesafe')
        const initialReads = reads
        assert.ok(initialReads > 0)
        keys['classifier-typesafe'] = 'second-classifier-key'
        const request = { ...CLASSIFIER_TEST_REQUEST, state: 'snapshot-chat-key' }
        await Promise.all([session.invokeBatch([request]), session.invokeBatch([request])])
        assert.equal(reads, initialReads, 'no repeated keyring lookups between fixtures')
        const next = createClassifierSession('typesafe')
        await next.invokeBatch([request])
        assert.ok(reads > initialReads)
      },
    )
    assert.deepEqual(authorization, [
      'Bearer first-classifier-key',
      'Bearer first-classifier-key',
      'Bearer second-classifier-key',
    ])
  })

  it('keeps a session configuration private and respects host approval revocation', async () => {
    const profile: ClassifierProfile = {
      ...preset('kev'),
      connection: {
        type: 'http',
        auth: 'none',
        protocol: 'systemone',
        baseUrl: 'https://classifier.example/v1',
      },
    }
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    await saveClassifierProfile(profile)
    const session = createClassifierSession(profile.id)
    session.profile.connection = {
      type: 'http',
      auth: 'none',
      protocol: 'systemone',
      baseUrl: 'https://another.example/v1',
    }
    const fetchMock = mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      assert.equal(url, 'https://classifier.example/v1/systemone')
      return response()
    })
    await session.invokeBatch([CLASSIFIER_TEST_REQUEST])
    await setSetting('approvedProviderHosts', [])
    await assert.rejects(session.invokeBatch([CLASSIFIER_TEST_REQUEST]), /not approved/)
    assert.equal(fetchMock.mock.callCount(), 1)
  })

  it('never sends saved credentials to a keyless local endpoint', async () => {
    await saveClassifierProfile(preset('kev'))
    setApiKey(classifierCredentialId('kev'), 'do-not-send')
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).has('Authorization'), false)
      return response()
    })
    await testClassifierProfile('kev')
  })

  it('redacts known literal keys from remote state and questions before transmission', async () => {
    await saveClassifierProfile(preset('typesafe'))
    await saveClassifierProfile(preset('kev'))
    setApiKey(classifierCredentialId('typesafe'), 'opaque-classifier-secret')
    setApiKey(classifierCredentialId('kev'), 'dormant-classifier-secret')
    setApiKey('openai', 'opaque-chat-secret')
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body
      assert.equal(typeof body, 'string')
      if (typeof body !== 'string') assert.fail('Expected JSON request body')
      assert.equal(body.includes('opaque-classifier-secret'), false)
      assert.equal(body.includes('opaque-chat-secret'), false)
      assert.equal(body.includes('dormant-classifier-secret'), false)
      assert.match(body, /REDACTED/)
      return response()
    })
    await invokeClassifierBatch('typesafe', [
      {
        state: {
          logs: ['opaque-classifier-secret', 'opaque-chat-secret', 'dormant-classifier-secret'],
        },
        questions: {
          color: {
            type: 'choice',
            instructions: 'opaque-chat-secret',
            options: { red: 'opaque-classifier-secret', blue: null },
          },
        },
      },
    ])
  })

  it('validates the entire batch before the first request', async () => {
    await saveClassifierProfile(preset('kev'))
    const fetchMock = mock.method(globalThis, 'fetch', async () => response())
    await assert.rejects(
      invokeClassifierBatch('kev', [CLASSIFIER_TEST_REQUEST, { state: '', questions: {} }]),
    )
    await assert.rejects(invokeClassifierBatch('kev', []), /1–1000/)
    assert.equal(fetchMock.mock.callCount(), 0)
  })
})
