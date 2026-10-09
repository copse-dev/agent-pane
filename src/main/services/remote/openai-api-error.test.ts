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

it('waits through ready instead of treating it as setup failure', async () => {
  let polls = 0
  const api = new OpenAiAgentsApi('key', async (input) => {
    if (
      new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      ).pathname.endsWith('/events')
    )
      return new Response('')
    return Response.json({ status: ++polls === 1 ? 'ready' : 'connected' })
  })
  await api.waitForEnvironment(
    {
      v: 1,
      sessionId: 'session',
      environmentId: 'env',
      model: 'model',
      pending: null,
      usageInput: 0,
      usageOutput: 0,
      usageCacheRead: 0,
    },
    AbortSignal.timeout(5000),
  )
  assert.equal(polls, 2)
})

it('includes a redacted provider setup error and actual status', async () => {
  const api = new OpenAiAgentsApi('secret-key', async (input) => {
    if (
      new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      ).pathname.endsWith('/events')
    )
      return new Response('')
    return Response.json({
      status: 'failed',
      error: {
        message: 'Setup command failed: secret-key https://codeload.github.com/repo?token=private',
      },
    })
  })
  await assert.rejects(
    api.waitForEnvironment(
      {
        v: 1,
        sessionId: 'session',
        environmentId: 'env',
        model: 'model',
        pending: null,
        usageInput: 0,
        usageOutput: 0,
        usageCacheRead: 0,
      },
      AbortSignal.timeout(1000),
    ),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /setup stopped \(failed\).*Setup command failed/)
      assert.doesNotMatch(error.message, /secret-key|token=private|expired/)
      return true
    },
  )
})

it('captures setup error events when environment polling contains only a status', async () => {
  const api = new OpenAiAgentsApi('secret-key', async (input) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      .pathname
    if (path.endsWith('/events'))
      return new Response(
        `data: ${JSON.stringify({ type: 'agent.session.environment.failed', environment: { error: { message: 'Bootstrap failed while applying local changes. secret-key' } } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    await new Promise((resolve) => setTimeout(resolve, 10))
    return Response.json({ status: 'failed' })
  })
  await assert.rejects(
    api.waitForEnvironment(
      {
        v: 1,
        sessionId: 'session',
        environmentId: 'env',
        model: 'model',
        pending: null,
        usageInput: 0,
        usageOutput: 0,
        usageCacheRead: 0,
      },
      AbortSignal.timeout(1000),
    ),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /applying local changes/)
      assert.doesNotMatch(error.message, /secret-key/)
      return true
    },
  )
})
