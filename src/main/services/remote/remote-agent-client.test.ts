import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk } from '@shared/types'
import {
  buildRemoteAgentContextPreamble,
  formatRemoteGitSummary,
  parseSseBlock,
  promptPayloadFromUserContent,
  remoteStreamEventToChunks,
  userContentToText,
  type RemoteStreamState,
} from '@shared/remote-agent-stream.ts'
import {
  fetchRemoteArtifactImageDataUrl,
  formatRemoteArtifactsSummary,
  resolveRemoteAgentRepository,
} from './remote-agent-client.ts'
import { storageSet } from '../storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

afterEach(() => {
  storageSet('projects', [])
  storageSet('activeProjectId', null)
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
})

describe('fetchRemoteArtifactImageDataUrl', () => {
  it('resolves the artifact download URL and returns image data', async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string): Promise<Response> => {
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
      fetchImpl: fetchImpl as typeof fetch,
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
    const fetchImpl = async (url: string): Promise<Response> => {
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
      fetchImpl: fetchImpl as typeof fetch,
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
    assert.match(preamble, /Assistant: \(used tools: read_file\)/)
    // System prompts and raw tool results stay out of the handoff.
    assert.doesNotMatch(preamble, /ignored system prompt/)
    assert.doesNotMatch(preamble, /contents/)
  })

  it('includes the branch even when there is no prior chat', () => {
    const preamble = buildRemoteAgentContextPreamble({ priorMessages: [], branch: 'main' })
    assert.match(preamble, /Current branch: `main`/)
    assert.doesNotMatch(preamble, /Prior conversation/)
  })

  it('flattens multimodal user content to its text parts', () => {
    assert.equal(
      userContentToText([
        { type: 'text', text: 'describe this' },
        { type: 'image', dataUrl: 'data:image/png;base64,abc' },
      ]),
      'describe this',
    )
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
