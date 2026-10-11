import assert from 'node:assert/strict'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { CLASSIFIER_PRESETS } from '@copse/llm/classifiers/presets.ts'
import type { ClassifierProfile } from '@copse/llm/classifiers/types.ts'
import { setApprovalHandler } from '../services/approval.ts'
import { saveClassifierProfile } from '../services/classifiers/classifier-service.ts'
import { setSetting } from '../services/storage/settings.ts'
import { readUsageEvents } from '../services/storage/usage-ledger.ts'
import { clearUsageLedger } from '../services/storage/usage-ledger.test-support.ts'
import { createClassifyTextTool } from './classifier-tool.ts'

const signal = new AbortController().signal
const ARGS = {
  classifier: 'remote',
  text: 'a note to classify',
  type: 'choice' as const,
  question: 'What is it?',
  options: ['note', 'bug'],
}

function remoteProfile(): ClassifierProfile {
  const kev = CLASSIFIER_PRESETS.find((entry) => entry.id === 'kev')
  assert.ok(kev)
  return {
    ...kev,
    id: 'remote',
    label: 'Remote classifier',
    connection: {
      type: 'http',
      protocol: 'systemone',
      auth: 'none',
      baseUrl: 'https://classifier.example/v1',
    },
  }
}

/** The shipped tool over the real classifier service and usage ledger; only the network is faked. */
describe('classify_text over the classifier service', () => {
  beforeEach(async () => {
    await clearUsageLedger()
    await setSetting('classifierProviders', { version: 1, profiles: [] })
    await setSetting('approvedProviderHosts', [])
    await setSetting('providerAllowUserApproval', true)
  })

  afterEach(() => {
    mock.restoreAll()
    setApprovalHandler(null)
  })

  it('needs the same host approval as the rest of the provider code', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    await saveClassifierProfile(remoteProfile())
    // The host was approved when the connection was saved; approval can be withdrawn later.
    await setSetting('approvedProviderHosts', [])
    const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({}))
    await assert.rejects(
      Promise.resolve(createClassifyTextTool().execute({ ...ARGS }, signal)),
      /not approved/,
    )
    assert.equal(fetchMock.mock.callCount(), 0, 'nothing is sent to an unapproved host')
    assert.deepEqual(await readUsageEvents(), [])
  })

  it('calls an approved connection and records classifier usage', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    await saveClassifierProfile(remoteProfile())
    let sent = ''
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      sent = typeof init?.body === 'string' ? init.body : ''
      return Response.json({
        model: 'remote-v2',
        answers: {
          answer: { type: 'choice', choice: 'note', probabilities: { note: 0.8, bug: 0.2 } },
        },
        usage: { input_tokens: 31, output_tokens: 2 },
      })
    })
    const out = await createClassifyTextTool().execute({ ...ARGS }, signal)
    assert.equal(parse(out)['choice'], 'note')
    assert.match(sent, /a note to classify/)

    const events = await readUsageEvents()
    assert.equal(events.length, 1)
    const [event] = events
    assert.equal(event?.source, 'classifier')
    assert.equal(event.model, 'remote-v2')
    assert.equal(event.provider, 'Remote classifier')
    assert.equal(event.inputTokens, 31)
    assert.equal(event.outputTokens, 2)
  })

  it('says so, and sends nothing, when no connection has that id', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({}))
    const out = await createClassifyTextTool().execute({ ...ARGS }, signal)
    assert.match(out, /No classifier "remote" is configured/)
    assert.equal(fetchMock.mock.callCount(), 0)
  })
})

function parse(text: string): Record<string, unknown> {
  const value = safeJsonParse(text)
  assert.ok(isRecord(value), 'a JSON object')
  return value
}
