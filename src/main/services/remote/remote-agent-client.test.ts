import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from '@copse/streaming-markdown'
import type { StreamChunk } from '@shared/types'
import {
  applyRemoteAgentHandoffContext,
  buildRemoteAgentContextPreamble,
  FATAL_REMOTE_STREAM_ERROR_CODES,
  formatRemoteGitSummary,
  MAX_REMOTE_PROMPT_IMAGES,
  parseSseBlock,
  promptPayloadFromUserContent,
  RemoteAgentStreamError,
  remoteStreamEventToChunks,
  userContentToText,
  type RemoteStreamState,
} from '@shared/remote-agent-stream.ts'
import {
  clearRemoteAgentSession,
  fetchRemoteArtifactImageDataUrl,
  formatRemoteArtifactsSummary,
  refreshRemoteAgentRun,
  remoteAgentBusyRetryDelayMs,
  resolveRemoteAgentRepository,
  runRemoteAgentFromSettings,
  setRemoteStreamReconnectDelayForTest,
} from './remote-agent-client.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { isRecord } from '@shared/unknown-value.ts'

afterEach(() => {
  storageSet('projects', [])
  storageSet('activeProjectId', null)
  setRemoteStreamReconnectDelayForTest(null)
  clearRemoteAgentSession('thread-cursor-reconnect')
})

function state(): RemoteStreamState {
  return {
    seenToolCalls: new Set(),
    assistantText: '',
    resultText: '',
    terminalStatus: null,
  }
}

describe('resolveRemoteAgentRepository', () => {
  it('uses the active project origin', async () => {
    const workspaceRoot = '/workspace-root'
    const projectRoot = '/project-root'
    const restoreWorkspace = setWorkspaceRootForTest(workspaceRoot)
    let resolvedRoot: string | null = null

    storageSet('projects', [{ id: 'project-1', path: projectRoot, name: 'project' }])
    storageSet('activeProjectId', 'project-1')

    try {
      const repository = await resolveRemoteAgentRepository({
        getGithubRepoSlug: async (root) => {
          resolvedRoot = root
          return 'acme/project'
        },
      })
      assert.equal(resolvedRoot, projectRoot)
      assert.equal(repository, 'https://github.com/acme/project')
    } finally {
      restoreWorkspace()
    }
  })

  it('returns null when the project has no GitHub remote', async () => {
    const restoreWorkspace = setWorkspaceRootForTest('/not-a-repo')
    try {
      const repository = await resolveRemoteAgentRepository({
        getGithubRepoSlug: async () => null,
      })
      assert.equal(repository, null)
    } finally {
      restoreWorkspace()
    }
  })
})

function cursorSse(events: Array<{ id?: string; event: string; data: unknown }>): string {
  return events
    .map((event) => {
      const idLine = event.id ? `id: ${event.id}\n` : ''
      return `${idLine}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
    })
    .join('')
}

describe('runRemoteAgentFromSettings (cursor)', () => {
  it('rejects a non-GitHub project with a Cursor-specific error', async () => {
    // No workspace and no active project → no repository can be resolved.
    const restoreWorkspace = setWorkspaceRootForTest(null)
    // The session store persists across runs; make sure no session is reused.
    clearRemoteAgentSession('thread-cursor-no-repo')
    const prevKey = process.env['CURSOR_API_KEY']
    process.env['CURSOR_API_KEY'] = 'test-key'
    try {
      await assert.rejects(
        runRemoteAgentFromSettings({
          threadId: 'thread-cursor-no-repo',
          provider: 'cursor',
          userPrompt: 'do something',
          signal: new AbortController().signal,
          onChunk: () => {},
          fetchImpl: () => {
            throw new Error('unexpected network call')
          },
        }),
        /needs a project backed by a GitHub remote/,
      )
    } finally {
      if (prevKey === undefined) delete process.env['CURSOR_API_KEY']
      else process.env['CURSOR_API_KEY'] = prevKey
      restoreWorkspace()
    }
  })

  it('reconnects after stream_unavailable and resumes with Last-Event-ID', async () => {
    setRemoteStreamReconnectDelayForTest(() => 0)
    const prevKey = process.env['CURSOR_API_KEY']
    process.env['CURSOR_API_KEY'] = 'test-key'
    storageSet('remote-agent-session:thread-cursor-reconnect', {
      v: 1,
      provider: 'cursor',
      baseUrl: 'https://api.cursor.com',
      agentId: 'bc-reconnect',
      url: 'https://cursor.com/agents/bc-reconnect',
    })

    const streamHeaders: Array<string | null> = []
    let streamAttempts = 0
    const chunks: StreamChunk[] = []

    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const url = new URL(href)
      const method = init?.method ?? 'GET'

      if (method === 'POST' && url.pathname === '/v1/agents/bc-reconnect/runs') {
        return new Response(JSON.stringify({ run: { id: 'run-1', agentId: 'bc-reconnect' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (method === 'GET' && url.pathname === '/v1/agents/bc-reconnect/runs/run-1/stream') {
        streamAttempts += 1
        streamHeaders.push(new Headers(init?.headers).get('Last-Event-ID'))
        if (streamAttempts === 1) {
          return new Response(
            cursorSse([
              { id: '100-0', event: 'assistant', data: { text: 'Digging into flicker paths.' } },
              {
                event: 'error',
                data: {
                  code: 'stream_unavailable',
                  message: 'Run stream is no longer available',
                },
              },
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response(
          cursorSse([
            { id: '100-0', event: 'assistant', data: { text: 'Digging into flicker paths.' } },
            { id: '101-0', event: 'assistant', data: { text: ' Fixed.' } },
            {
              id: '102-0',
              event: 'result',
              data: { status: 'FINISHED', text: 'Digging into flicker paths. Fixed.' },
            },
            { event: 'done', data: {} },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }

      if (method === 'GET' && url.pathname === '/v1/agents/bc-reconnect/runs/run-1') {
        return new Response(JSON.stringify({ id: 'run-1', status: 'RUNNING', result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (method === 'GET' && url.pathname === '/v1/agents/bc-reconnect/usage') {
        return new Response(JSON.stringify({ runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (method === 'GET' && url.pathname === '/v1/agents/bc-reconnect/artifacts') {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      throw new Error(`Unexpected request: ${method} ${url.pathname}`)
    }

    try {
      const result = await runRemoteAgentFromSettings({
        threadId: 'thread-cursor-reconnect',
        provider: 'cursor',
        userPrompt: 'are we sure about subagent flickers',
        signal: new AbortController().signal,
        onChunk: (chunk) => chunks.push(chunk),
        fetchImpl,
      })

      assert.equal(streamAttempts, 2)
      assert.equal(streamHeaders[0], null)
      assert.equal(streamHeaders[1], '100-0')
      assert.equal(result.assistantText, 'Digging into flicker paths. Fixed.')
      const assistantText = chunks
        .filter((chunk): chunk is { type: 'text'; text: string } => chunk.type === 'text')
        .map((chunk) => chunk.text)
        .join('')
      assert.match(assistantText, /Digging into flicker paths\. Fixed\./)
      // Replayed id 100-0 on the second attempt must not double the first delta.
      assert.equal(assistantText.match(/Digging into flicker paths\./g)?.length, 1)
    } finally {
      if (prevKey === undefined) delete process.env['CURSOR_API_KEY']
      else process.env['CURSOR_API_KEY'] = prevKey
    }
  })
})

describe('refreshRemoteAgentRun (issue #2446 — reopen refresh)', () => {
  const threadId = 'thread-refresh-2446'
  const agentId = 'bc-refresh-2446'
  const runId = 'run-refresh-2446'
  const baseUrl = 'https://api.cursor.com'

  function seedSession(extra: Record<string, unknown> = {}): void {
    storageSet(`remote-agent-session:${threadId}`, {
      v: 1,
      provider: 'cursor',
      baseUrl,
      agentId,
      runId,
      ...extra,
    })
  }

  function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    return input.url
  }

  function syncedTerminalStatusOf(id: string): unknown {
    const raw = storageGet(`remote-agent-session:${id}`)
    return isRecord(raw) ? raw['syncedTerminalStatus'] : undefined
  }

  let prevApiKey: string | undefined
  beforeEach(() => {
    prevApiKey = process.env['CURSOR_API_KEY']
    process.env['CURSOR_API_KEY'] = 'test-key'
  })
  afterEach(() => {
    clearRemoteAgentSession(threadId)
    clearRemoteAgentSession('thread-refresh-no-session')
    if (prevApiKey === undefined) delete process.env['CURSOR_API_KEY']
    else process.env['CURSOR_API_KEY'] = prevApiKey
  })

  it('resolves with no request when the thread has no remote-agent session', async () => {
    const fetchImpl: typeof fetch = () => {
      throw new Error('unexpected network call')
    }
    const outcome = await refreshRemoteAgentRun({
      threadId: 'thread-refresh-no-session',
      signal: new AbortController().signal,
      onChunk: () => {
        throw new Error('unexpected chunk')
      },
      fetchImpl,
    })
    assert.deepEqual(outcome, { kind: 'no-session' })
  })

  it('resolves with no request for a session predating runId (no reopen-refresh support yet)', async () => {
    storageSet(`remote-agent-session:${threadId}`, {
      v: 1,
      provider: 'cursor',
      baseUrl,
      agentId,
    })
    const outcome = await refreshRemoteAgentRun({
      threadId,
      signal: new AbortController().signal,
      onChunk: () => {
        throw new Error('unexpected chunk')
      },
      fetchImpl: () => {
        throw new Error('unexpected network call')
      },
    })
    assert.deepEqual(outcome, { kind: 'no-session' })
  })

  it('applies a terminal run snapshot once, then skips entirely once synced', async () => {
    seedSession()
    let getRunCalls = 0
    const fetchImpl: typeof fetch = async (input) => {
      const url = requestUrl(input)
      if (url === `${baseUrl}/v1/agents/${agentId}/runs/${runId}`) {
        getRunCalls += 1
        return new Response(
          JSON.stringify({ id: runId, status: 'FINISHED', result: 'Final answer, applied once.' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const chunks: StreamChunk[] = []
    const outcome = await refreshRemoteAgentRun({
      threadId,
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
      fetchImpl,
    })

    assert.deepEqual(outcome, { kind: 'snapshot', status: 'FINISHED' })
    assert.equal(getRunCalls, 1)
    assert.deepEqual(chunks, [{ type: 'text', text: 'Final answer, applied once.' }])
    assert.equal(syncedTerminalStatusOf(threadId), 'FINISHED')

    // A later activation (e.g. reopening the editor again) must not re-fetch or
    // re-apply the same result — the whole point of recording the sync above.
    const secondChunks: StreamChunk[] = []
    const secondOutcome = await refreshRemoteAgentRun({
      threadId,
      signal: new AbortController().signal,
      onChunk: (chunk) => secondChunks.push(chunk),
      fetchImpl: () => {
        throw new Error('unexpected network call on an already-synced thread')
      },
    })
    assert.deepEqual(secondOutcome, { kind: 'already-synced' })
    assert.equal(getRunCalls, 1, 'no additional Get A Run call')
    assert.deepEqual(secondChunks, [], 'no duplicate message appended')
  })

  it('reattaches the stream for a run still in progress and applies its tail', async () => {
    seedSession()
    let getRunCalls = 0
    let streamCalls = 0
    const streamHeaders: Array<string | null> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url === `${baseUrl}/v1/agents/${agentId}/runs/${runId}`) {
        getRunCalls += 1
        return new Response(JSON.stringify({ id: runId, status: 'RUNNING', result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `${baseUrl}/v1/agents/${agentId}/runs/${runId}/stream`) {
        streamCalls += 1
        streamHeaders.push(new Headers(init?.headers).get('Last-Event-ID'))
        return new Response(
          cursorSse([
            { id: '1-0', event: 'assistant', data: { text: 'Reattached and still going.' } },
            {
              id: '2-0',
              event: 'result',
              data: { status: 'FINISHED', text: 'Reattached and still going.' },
            },
            { event: 'done', data: {} },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const chunks: StreamChunk[] = []
    const outcome = await refreshRemoteAgentRun({
      threadId,
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
      fetchImpl,
    })

    assert.deepEqual(outcome, { kind: 'reattached', status: 'FINISHED' })
    assert.equal(getRunCalls, 1)
    assert.equal(streamCalls, 1)
    // First reattach this session — no resume cursor persisted yet.
    assert.equal(streamHeaders[0], null)
    const text = chunks
      .filter((chunk): chunk is { type: 'text'; text: string } => chunk.type === 'text')
      .map((chunk) => chunk.text)
      .join('')
    assert.match(text, /Reattached and still going\./)
    assert.equal(
      text.match(/Reattached and still going\./g)?.length,
      1,
      'the result event echoing already-streamed text must not duplicate it',
    )
    assert.equal(syncedTerminalStatusOf(threadId), 'FINISHED')
  })

  it('resumes a reattached stream from its last-seen event id, skipping Get A Run entirely', async () => {
    // Simulate a session that already reattached partway (e.g. the app was
    // closed again mid-stream): the resume point is what was last persisted.
    seedSession({ lastEventId: '5-0' })
    let getRunCalls = 0
    const streamHeaders: Array<string | null> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url === `${baseUrl}/v1/agents/${agentId}/runs/${runId}`) {
        getRunCalls += 1
        return new Response(JSON.stringify({ id: runId, status: 'RUNNING', result: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `${baseUrl}/v1/agents/${agentId}/runs/${runId}/stream`) {
        streamHeaders.push(new Headers(init?.headers).get('Last-Event-ID'))
        return new Response(
          cursorSse([
            { id: '6-0', event: 'result', data: { status: 'FINISHED', text: 'tail only' } },
            { event: 'done', data: {} },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    await refreshRemoteAgentRun({
      threadId,
      signal: new AbortController().signal,
      onChunk: () => {},
      fetchImpl,
    })

    assert.equal(streamHeaders[0], '5-0')
    // A resume point already tells the stream where to pick up — a separate
    // Get A Run first would be a redundant request (issue #2446 review).
    assert.equal(getRunCalls, 0)
  })

  it('a terminal run with a persisted last-seen event id resumes the stream instead of re-emitting the full result', async () => {
    // The app quit mid-run after some assistant text had already streamed in
    // (persisting `lastEventId`), and the run finished on Cursor's side before
    // the thread was reopened. Taking the snapshot branch here would re-append
    // the *whole* result on top of the partial text already in the transcript
    // — this must resume the stream and receive only the tail instead.
    seedSession({ lastEventId: '5-0' })
    let getRunCalls = 0
    const streamHeaders: Array<string | null> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url === `${baseUrl}/v1/agents/${agentId}/runs/${runId}`) {
        getRunCalls += 1
        // If this were called, it would report the run as already finished —
        // proving the assertions below are checking the right thing.
        return new Response(
          JSON.stringify({ id: runId, status: 'FINISHED', result: 'Full answer, already shown.' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === `${baseUrl}/v1/agents/${agentId}/runs/${runId}/stream`) {
        streamHeaders.push(new Headers(init?.headers).get('Last-Event-ID'))
        return new Response(
          cursorSse([
            {
              id: '6-0',
              event: 'result',
              data: { status: 'FINISHED', text: 'Full answer, already shown.' },
            },
            { event: 'done', data: {} },
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const chunks: StreamChunk[] = []
    const outcome = await refreshRemoteAgentRun({
      threadId,
      signal: new AbortController().signal,
      onChunk: (chunk) => chunks.push(chunk),
      fetchImpl,
    })

    assert.deepEqual(outcome, { kind: 'reattached', status: 'FINISHED' })
    assert.equal(getRunCalls, 0, 'Get A Run must be skipped once a resume point exists')
    assert.equal(streamHeaders[0], '5-0', 'the stream resumes from the persisted event id')
    // The result event's text lands exactly once — no snapshot re-emitting the
    // whole result on top of it.
    const texts = chunks.filter(
      (chunk): chunk is { type: 'text'; text: string } => chunk.type === 'text',
    )
    assert.deepEqual(texts, [{ type: 'text', text: 'Full answer, already shown.' }])
    assert.equal(syncedTerminalStatusOf(threadId), 'FINISHED')
  })

  it('coalesces concurrent refreshes for the same thread into one request', async () => {
    seedSession()
    let getRunCalls = 0
    const fetchImpl: typeof fetch = async (input) => {
      const url = requestUrl(input)
      if (url === `${baseUrl}/v1/agents/${agentId}/runs/${runId}`) {
        getRunCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return new Response(
          JSON.stringify({ id: runId, status: 'FINISHED', result: 'done once' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const [a, b] = await Promise.all([
      refreshRemoteAgentRun({
        threadId,
        signal: new AbortController().signal,
        onChunk: () => {},
        fetchImpl,
      }),
      refreshRemoteAgentRun({
        threadId,
        signal: new AbortController().signal,
        onChunk: () => {},
        fetchImpl,
      }),
    ])

    assert.equal(getRunCalls, 1, 'concurrent activations share one in-flight request')
    assert.deepEqual(a, { kind: 'snapshot', status: 'FINISHED' })
    assert.deepEqual(b, a)
  })

  it('skips a thread on a provider this refresh does not cover', async () => {
    storageSet(`remote-agent-session:${threadId}`, {
      v: 1,
      provider: 'anthropic',
      baseUrl,
      agentId,
      runId,
    })
    const outcome = await refreshRemoteAgentRun({
      threadId,
      signal: new AbortController().signal,
      onChunk: () => {
        throw new Error('unexpected chunk')
      },
      fetchImpl: () => {
        throw new Error('unexpected network call')
      },
    })
    assert.deepEqual(outcome, { kind: 'unsupported-provider' })
  })
})

describe('remote agent SSE parsing', () => {
  it('parses event, id, and multiline data fields', () => {
    const event = parseSseBlock(
      'id: 1-0\nevent: assistant\ndata: {"text":"hello"}\ndata: {"extra":true}',
    )

    assert.deepEqual(event, {
      id: '1-0',
      event: 'assistant',
      data: '{"text":"hello"}\n{"extra":true}',
    })
  })
})

describe('remoteStreamEventToChunks', () => {
  it('maps assistant deltas to normal text chunks', () => {
    const current = state()
    const chunks = remoteStreamEventToChunks(
      { event: 'assistant', data: JSON.stringify({ text: 'Hello' }) },
      current,
    )

    assert.deepEqual(chunks, [{ type: 'text', text: 'Hello' }])
    assert.equal(current.assistantText, 'Hello')
  })

  it('maps tool call lifecycle updates to existing tool chunks', () => {
    const current = state()
    const running = remoteStreamEventToChunks(
      {
        event: 'tool_call',
        data: JSON.stringify({
          callId: 'call-1',
          name: 'read_file',
          status: 'running',
          args: { path: 'README.md' },
        }),
      },
      current,
    )
    const completed = remoteStreamEventToChunks(
      {
        event: 'tool_call',
        data: JSON.stringify({
          callId: 'call-1',
          name: 'read_file',
          status: 'completed',
          result: { success: { content: '# Project' } },
        }),
      },
      current,
    )

    assert.deepEqual(running, [
      {
        type: 'tool_call',
        toolCall: { id: 'call-1', name: 'read_file', args: { path: 'README.md' } },
      },
    ] satisfies StreamChunk[])
    assert.deepEqual(completed, [
      {
        type: 'tool_result',
        toolCallId: 'call-1',
        result: '{\n  "success": {\n    "content": "# Project"\n  }\n}',
        isError: false,
      },
    ] satisfies StreamChunk[])
  })

  it('emits result text only when assistant deltas did not already stream', () => {
    const current = state()
    const chunks = remoteStreamEventToChunks(
      {
        event: 'result',
        data: JSON.stringify({ status: 'FINISHED', text: 'Final answer' }),
      },
      current,
    )

    assert.deepEqual(chunks, [{ type: 'text', text: 'Final answer' }])
    assert.equal(current.assistantText, 'Final answer')
    assert.equal(current.terminalStatus, 'FINISHED')
  })

  it('treats null result fields as absent', () => {
    const current = state()
    assert.deepEqual(
      remoteStreamEventToChunks(
        { event: 'result', data: JSON.stringify({ status: null, text: null }) },
        current,
      ),
      [],
    )
    assert.equal(current.terminalStatus, null)
    assert.equal(current.resultText, '')
  })

  it('appends a pushed-branch summary after already-streamed assistant text', () => {
    const current = state()
    current.assistantText = 'Done.'
    const chunks = remoteStreamEventToChunks(
      {
        event: 'result',
        data: JSON.stringify({
          status: 'FINISHED',
          text: 'Done.',
          git: {
            branches: [{ repoUrl: 'github.com/acme/repo', branch: 'cursor/add-readme-a1b2' }],
          },
        }),
      },
      current,
    )

    assert.equal(chunks.length, 1)
    assert.equal(chunks[0]?.type, 'text')
    assert.match(
      (chunks[0] as { text: string }).text,
      /Pushed branch `cursor\/add-readme-a1b2` on github\.com\/acme\/repo/,
    )
  })

  it('marks stream_unavailable as recoverable and auth errors as fatal', () => {
    const current = state()
    assert.throws(
      () =>
        remoteStreamEventToChunks(
          {
            event: 'error',
            data: JSON.stringify({
              code: 'stream_unavailable',
              message: 'Run stream is no longer available',
            }),
          },
          current,
        ),
      (err: unknown) =>
        err instanceof RemoteAgentStreamError && err.code === 'stream_unavailable' && !err.fatal,
    )
    assert.throws(
      () =>
        remoteStreamEventToChunks(
          {
            event: 'error',
            data: JSON.stringify({ code: 'unauthorized', message: 'bad key' }),
          },
          current,
        ),
      (err: unknown) =>
        err instanceof RemoteAgentStreamError && err.code === 'unauthorized' && err.fatal,
    )
    assert.ok(FATAL_REMOTE_STREAM_ERROR_CODES.has('not_found'))
  })
})

describe('formatRemoteGitSummary', () => {
  it('returns an empty string when there are no pushed branches', () => {
    assert.equal(formatRemoteGitSummary(undefined), '')
    assert.equal(formatRemoteGitSummary({ branches: [] }), '')
  })

  it('includes the PR url when the remote agent opened one', () => {
    const summary = formatRemoteGitSummary({
      branches: [
        {
          repoUrl: 'github.com/acme/repo',
          branch: 'cursor/fix',
          prUrl: 'https://github.com/acme/repo/pull/7',
        },
      ],
    })

    assert.match(summary, /https:\/\/github\.com\/acme\/repo\/pull\/7/)
  })
})

describe('formatRemoteArtifactsSummary', () => {
  it('lists remote artifacts with API download links', () => {
    const summary = formatRemoteArtifactsSummary({
      agentId: 'bc-00000000-0000-0000-0000-000000000001',
      baseUrl: 'https://api.cursor.com',
      artifacts: [
        {
          path: 'artifacts/screenshot.png',
          sizeBytes: 12_345,
          updatedAt: '2026-04-13T18:45:00.000Z',
        },
      ],
    })

    assert.match(summary, /Remote agent artifacts/)
    assert.match(summary, /`artifacts\/screenshot\.png` \(12\.1 KB\)/)
    assert.match(
      summary,
      /https:\/\/api\.cursor\.com\/v1\/agents\/bc-00000000-0000-0000-0000-000000000001\/artifacts\/download\?path=artifacts%2Fscreenshot\.png/,
    )
  })

  it('keeps backticks in artifact paths inside inline code', () => {
    const path = 'artifacts/report` [Injected](https://evil.example).txt'
    const summary = formatRemoteArtifactsSummary({
      agentId: 'bc-00000000-0000-0000-0000-000000000001',
      baseUrl: 'https://api.cursor.com',
      artifacts: [{ path }],
    })
    const html = renderMarkdownUnsafe(summary)

    assert.ok(html.includes(`<code>${path}</code>`))
    assert.doesNotMatch(html, /href="https:\/\/evil\.example"/)
    assert.match(html, /artifacts%2Freport%60/)
  })
})

describe('fetchRemoteArtifactImageDataUrl', () => {
  it('resolves the artifact download URL and returns image data', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      if (url.includes('/artifacts/download')) {
        return new Response(
          JSON.stringify({
            url: 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/screenshot.png',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '3' },
      })
    }

    const dataUrl = await fetchRemoteArtifactImageDataUrl({
      fetchImpl,
      baseUrl: 'https://api.cursor.com',
      apiKey: 'key',
      agentId: 'bc-00000000-0000-0000-0000-000000000001',
      path: 'artifacts/screenshot.png',
    })

    assert.equal(dataUrl, 'data:image/png;base64,AQID')
    assert.deepEqual(calls, [
      'https://api.cursor.com/v1/agents/bc-00000000-0000-0000-0000-000000000001/artifacts/download?path=artifacts%2Fscreenshot.png',
      'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/screenshot.png',
    ])
  })

  it('caches artifact image data by agent and path for the app session', async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async (input): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls++
      if (url.includes('/artifacts/download')) {
        return new Response(
          JSON.stringify({
            url: 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/cached.png',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(Uint8Array.from([4, 5, 6]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '3' },
      })
    }

    const input = {
      fetchImpl,
      baseUrl: 'https://api.cursor.com',
      apiKey: 'key',
      agentId: 'bc-00000000-0000-0000-0000-000000000002',
      path: 'artifacts/cached.png',
    }
    const first = await fetchRemoteArtifactImageDataUrl(input)
    const second = await fetchRemoteArtifactImageDataUrl(input)

    assert.equal(first, 'data:image/png;base64,BAUG')
    assert.equal(second, first)
    assert.equal(calls, 2)
  })
})

describe('buildRemoteAgentContextPreamble', () => {
  it('returns empty when there is no prior chat and no branch', () => {
    assert.equal(buildRemoteAgentContextPreamble({ priorMessages: [] }), '')
    assert.equal(buildRemoteAgentContextPreamble({ priorMessages: [], branch: '  ' }), '')
  })

  it('dumps prior user/assistant turns and the branch into the handoff', () => {
    const preamble = buildRemoteAgentContextPreamble({
      branch: 'fix-commonmark-heading-support',
      priorMessages: [
        { role: 'system', content: 'ignored system prompt' },
        { role: 'user', content: 'Fix the heading parser' },
        { role: 'assistant', content: 'Looking into it.' },
        {
          role: 'assistant',
          content: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
        },
        { role: 'tool', toolResults: [{ toolCallId: 'c1', result: 'contents' }] },
      ],
    })

    assert.match(preamble, /Current branch: `fix-commonmark-heading-support`/)
    assert.match(preamble, /User: Fix the heading parser/)
    assert.match(preamble, /Assistant: Looking into it\./)
    // Name-only tool-call turns add no actionable detail — omit them.
    assert.doesNotMatch(preamble, /used tools/)
    assert.doesNotMatch(preamble, /read_file/)
    // System prompts and raw tool results stay out of the handoff.
    assert.doesNotMatch(preamble, /ignored system prompt/)
    assert.doesNotMatch(preamble, /contents/)
  })

  it('skips the continue-steer when there is no prior chat (even with a branch)', () => {
    // Branch is already sent via startingRef / managed-agent system prompt; a
    // fresh thread has nothing to hand off, so the preamble stays empty.
    assert.equal(buildRemoteAgentContextPreamble({ priorMessages: [], branch: 'main' }), '')
  })

  it('marks prior image attachments in the transcript text', () => {
    assert.equal(
      userContentToText([
        { type: 'text', text: 'describe this' },
        { type: 'image', dataUrl: 'data:image/png;base64,abc' },
      ]),
      'describe this\n[image]',
    )
  })
})

describe('applyRemoteAgentHandoffContext', () => {
  it('forwards prior-turn images on first handoff and prefers current-turn images', () => {
    const priorMessages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'first shot' },
          { type: 'image' as const, dataUrl: 'data:image/png;base64,prior1' },
        ],
      },
      { role: 'assistant' as const, content: 'Got it.' },
      {
        role: 'user' as const,
        content: [{ type: 'image' as const, dataUrl: 'data:image/jpeg;base64,prior2' }],
      },
    ]
    const prompt = {
      text: 'and this one?',
      images: [{ mimeType: 'image/png', data: 'current' }],
    }

    const handedOff = applyRemoteAgentHandoffContext(prompt, { priorMessages, branch: 'main' })

    assert.match(handedOff.text, /User: first shot\n\[image\]/)
    assert.match(handedOff.text, /User: \[image\]/)
    assert.match(handedOff.text, /--- New message ---\nand this one\?/)
    assert.deepEqual(handedOff.images, [
      { mimeType: 'image/png', data: 'prior1' },
      { mimeType: 'image/jpeg', data: 'prior2' },
      { mimeType: 'image/png', data: 'current' },
    ])
  })

  it('keeps current-turn images when the prior image budget is exhausted', () => {
    const priorMessages = Array.from({ length: MAX_REMOTE_PROMPT_IMAGES + 2 }, (_, i) => ({
      role: 'user' as const,
      content: [{ type: 'image' as const, dataUrl: `data:image/png;base64,prior${String(i)}` }],
    }))
    const currentImages = [
      { mimeType: 'image/png', data: 'c0' },
      { mimeType: 'image/png', data: 'c1' },
    ]
    const handedOff = applyRemoteAgentHandoffContext(
      { text: 'latest', images: currentImages },
      { priorMessages },
    )

    assert.ok(handedOff.images)
    assert.equal(handedOff.images.length, MAX_REMOTE_PROMPT_IMAGES)
    assert.deepEqual(handedOff.images.slice(-currentImages.length), currentImages)
    // Most recent prior images fill the leftover slots (prior0…prior6 available).
    assert.deepEqual(handedOff.images.slice(0, MAX_REMOTE_PROMPT_IMAGES - currentImages.length), [
      { mimeType: 'image/png', data: 'prior4' },
      { mimeType: 'image/png', data: 'prior5' },
      { mimeType: 'image/png', data: 'prior6' },
    ])
  })
})

describe('promptPayloadFromUserContent', () => {
  it('converts text and image blocks to Cursor-compatible prompt payloads', () => {
    const payload = promptPayloadFromUserContent([
      { type: 'text', text: 'Inspect this' },
      { type: 'image', dataUrl: 'data:image/png;base64,abc123' },
    ])

    assert.deepEqual(payload, {
      text: 'Inspect this',
      images: [{ mimeType: 'image/png', data: 'abc123' }],
    })
  })
})

describe('remoteAgentBusyRetryDelayMs', () => {
  it('grows exponentially and caps at 1s', () => {
    assert.equal(remoteAgentBusyRetryDelayMs(0), 100)
    assert.equal(remoteAgentBusyRetryDelayMs(1), 200)
    assert.equal(remoteAgentBusyRetryDelayMs(2), 400)
    assert.equal(remoteAgentBusyRetryDelayMs(3), 800)
    assert.equal(remoteAgentBusyRetryDelayMs(4), 1000)
    assert.equal(remoteAgentBusyRetryDelayMs(8), 1000)
  })
})

describe('runRemoteAgentFromSettings follow-up after cancel', () => {
  const threadId = 'thread-cursor-busy-retry'
  const agentId = 'bc-00000000-0000-0000-0000-000000000099'
  const baseUrl = 'https://api.cursor.com'

  afterEach(() => {
    clearRemoteAgentSession(threadId)
    mock.timers.reset()
  })

  function seedSession(): void {
    storageSet(`remote-agent-session:${threadId}`, {
      v: 1,
      provider: 'cursor',
      baseUrl,
      agentId,
    })
  }

  function sseStream(body: string): Response {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input
    if (input instanceof URL) return input.href
    return input.url
  }

  it('retries create-run on 409 agent_busy then continues the follow-up', async () => {
    seedSession()
    mock.timers.enable({ apis: ['setTimeout'] })
    const prevKey = process.env['CURSOR_API_KEY']
    process.env['CURSOR_API_KEY'] = 'test-key'
    let createAttempts = 0
    const chunks: StreamChunk[] = []

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url.endsWith(`/v1/agents/${agentId}/runs`) && init?.method === 'POST') {
        createAttempts += 1
        if (createAttempts === 1) {
          return new Response(JSON.stringify({ error: 'agent_busy' }), { status: 409 })
        }
        return new Response(JSON.stringify({ run: { id: 'run-follow-up' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/runs/run-follow-up/stream')) {
        return sseStream(
          'event: assistant\ndata: {"text":"ok"}\n\nevent: result\ndata: {"status":"FINISHED","text":"ok"}\n\nevent: done\ndata: {}\n\n',
        )
      }
      if (url.includes('/usage') || url.includes('/artifacts')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    try {
      const runPromise = runRemoteAgentFromSettings({
        threadId,
        provider: 'cursor',
        userPrompt: 'send now follow-up',
        signal: new AbortController().signal,
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
        fetchImpl,
      })
      // Advance past the first busy-retry sleep without waiting wall-clock time.
      await Promise.resolve()
      mock.timers.tick(remoteAgentBusyRetryDelayMs(0))
      const result = await runPromise
      assert.equal(createAttempts, 2)
      assert.equal(result.assistantText, 'ok')
      assert.ok(chunks.some((c) => c.type === 'done'))
    } finally {
      if (prevKey === undefined) delete process.env['CURSOR_API_KEY']
      else process.env['CURSOR_API_KEY'] = prevKey
    }
  })

  it('cancels the active run and emits CANCELLED done on abort (Send now / Stop)', async () => {
    seedSession()
    const prevKey = process.env['CURSOR_API_KEY']
    process.env['CURSOR_API_KEY'] = 'test-key'
    const chunks: StreamChunk[] = []
    let cancelCalls = 0
    const controller = new AbortController()

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input)
      if (url.endsWith(`/v1/agents/${agentId}/runs`) && init?.method === 'POST') {
        return new Response(JSON.stringify({ run: { id: 'run-active' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/runs/run-active/stream')) {
        // Abort while the stream is open so the abort listener cancels the run.
        queueMicrotask(() => {
          controller.abort()
        })
        return new Promise((_resolve, reject) => {
          const onAbort = (): void => {
            reject(new DOMException('Aborted', 'AbortError'))
          }
          if (init?.signal?.aborted) onAbort()
          else init?.signal?.addEventListener('abort', onAbort, { once: true })
        })
      }
      if (url.includes('/runs/run-active/cancel') && init?.method === 'POST') {
        cancelCalls += 1
        return new Response(null, { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    try {
      const result = await runRemoteAgentFromSettings({
        threadId,
        provider: 'cursor',
        userPrompt: 'interrupt me',
        signal: controller.signal,
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
        fetchImpl,
      })
      assert.equal(cancelCalls, 1)
      assert.deepEqual(result.messages, [])
      assert.ok(
        chunks.some((c) => c.type === 'done' && c.stopReason === 'CANCELLED'),
        'expected CANCELLED done chunk after abort',
      )
      assert.equal(
        chunks.some((c) => c.type === 'text' && /error occurred/i.test(c.text)),
        false,
        'abort must not surface as a provider error',
      )
    } finally {
      if (prevKey === undefined) delete process.env['CURSOR_API_KEY']
      else process.env['CURSOR_API_KEY'] = prevKey
    }
  })
})
