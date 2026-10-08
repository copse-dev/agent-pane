import assert from 'node:assert/strict'
import { it } from 'node:test'
import { openAiApiError } from './openai-api-error.ts'
import { OpenAiAgentsApi } from './openai-agents-api.ts'

it('identifies creation failures with provider reason, parameter and request ID', async () => {
  const api = new OpenAiAgentsApi('secret-key', async () =>
    Response.json(
      {
        error: {
          message: 'File is unavailable.',
          code: 'invalid_value',
          param: 'environment.files[0].file_id',
        },
      },
      { status: 400, headers: { 'x-request-id': 'req-test' } },
    ),
  )
  await assert.rejects(api.create('gpt-6.1-sol', AbortSignal.timeout(1000)), (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /POST \/agents\/sessions/)
    assert.match(error.message, /File is unavailable/)
    assert.ok(error.message.includes('environment.files\\[0\\].file\\_id'))
    assert.match(error.message, /req-test/)
    return true
  })
})

it('reports file-upload failures at the correct operation', async () => {
  const api = new OpenAiAgentsApi('key', async () =>
    Response.json(
      { error: { message: 'Unsupported purpose.', param: 'purpose' } },
      { status: 400 },
    ),
  )
  await assert.rejects(
    api.uploadSource(Buffer.from('source'), AbortSignal.timeout(1000)),
    /POST \/files \(source upload\).*Unsupported purpose.*purpose/,
  )
})

it('redacts keys, bearer credentials, image bytes and URLs from structured diagnostics', async () => {
  const error = await openAiApiError(
    Response.json(
      {
        error: {
          message:
            'secret-key sk-another_key Bearer abc data:image/png;base64,aGVsbG8= https://example.com/?token=abc <img>',
        },
      },
      { status: 400 },
    ),
    'POST /agents/sessions',
    'secret-key',
  )
  assert.doesNotMatch(
    error.message,
    /secret-key|sk-another|Bearer abc|aGVsbG8|example.com|token=abc/,
  )
  assert.ok(error.message.includes('\\<img\\>'))
})

it('does not echo malformed, unstructured or oversized response bodies', async () => {
  for (const body of [
    '<html>private body</html>',
    JSON.stringify({ message: 'private body' }),
    JSON.stringify({ error: { message: 'x'.repeat(70 * 1024) } }),
  ]) {
    const error = await openAiApiError(
      new Response(body, { status: 400 }),
      'GET /agents/environments/env',
      'key',
    )
    assert.equal(error.message, 'OpenAI Agents API HTTP 400 (GET /agents/environments/env).')
  }
})
