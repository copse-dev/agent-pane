import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  invalidateCursorCloudModelsCache,
  listCursorCloudModels,
  parseCursorCloudModelsPayload,
} from './cursor-cloud-models.ts'
import { setSetting } from '../storage/settings.ts'

afterEach(async () => {
  invalidateCursorCloudModelsCache()
  await setSetting('remoteAgentBaseUrl', '')
})

describe('parseCursorCloudModelsPayload', () => {
  it('extracts id + displayName rows and skips duplicates / junk', () => {
    const models = parseCursorCloudModelsPayload({
      items: [
        { id: 'composer-2', displayName: 'Composer 2' },
        { id: 'composer-2', displayName: 'Duplicate' },
        { id: '  ', displayName: 'blank' },
        { displayName: 'missing id' },
        { id: 'claude-4.6-sonnet-thinking', displayName: 'Claude 4.6 Sonnet (Thinking)' },
        null,
        [],
      ],
    })
    assert.deepEqual(models, [
      { id: 'composer-2', label: 'Composer 2' },
      { id: 'claude-4.6-sonnet-thinking', label: 'Claude 4.6 Sonnet (Thinking)' },
    ])
  })

  it('falls back to id when displayName is absent', () => {
    assert.deepEqual(parseCursorCloudModelsPayload({ items: [{ id: 'composer-2' }] }), [
      { id: 'composer-2', label: 'composer-2' },
    ])
  })
})

describe('listCursorCloudModels', () => {
  const prevKey = process.env['CURSOR_API_KEY']

  afterEach(() => {
    if (prevKey === undefined) delete process.env['CURSOR_API_KEY']
    else process.env['CURSOR_API_KEY'] = prevKey
  })

  it('returns [] without a Cursor key', async () => {
    delete process.env['CURSOR_API_KEY']
    const models = await listCursorCloudModels({
      fetchImpl: () => {
        throw new Error('unexpected fetch')
      },
    })
    assert.deepEqual(models, [])
  })

  it('fetches from remoteAgentBaseUrl when configured', async () => {
    process.env['CURSOR_API_KEY'] = 'test-cursor-key'
    await setSetting('remoteAgentBaseUrl', 'http://127.0.0.1:59999')
    let requested: string | null = null
    const models = await listCursorCloudModels({
      fetchImpl: async (input) => {
        requested = typeof input === 'string' || input instanceof URL ? String(input) : input.url
        return new Response(
          JSON.stringify({
            items: [{ id: 'composer-2', displayName: 'Composer 2' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    assert.equal(requested, 'http://127.0.0.1:59999/v1/models')
    assert.deepEqual(models, [{ id: 'composer-2', label: 'Composer 2' }])
  })
})
