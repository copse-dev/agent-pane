import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamChunk } from '@shared/types'
import { setApiKey, deleteApiKey } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { threadDirectoryPath } from '../thread-store.ts'
import { runRemoteAgentFromSettings } from './remote-agent-client.ts'
import { runHostedGitTransfer } from './openai-git-worker.ts'
import { clearOpenAiAgentSession, readOpenAiArtifact } from './openai-agents-client.ts'

const page = (data: unknown[]): Response => Response.json({ data, has_more: false, last_id: null })

describe('OpenAI cloud adapter', () => {
  let root = ''
  let restoreWorkspace: () => void = () => {}
  let previousRoot: string | undefined
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-openai-test-'))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-b', 'feature'], { cwd: repo })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { cwd: repo },
    )
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    restoreWorkspace = setWorkspaceRootForTest(repo)
    const originalRead = fs.readFile
    mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) =>
      typeof args[0] === 'string' && args[0].endsWith('openai-git-worker.cjs')
        ? Promise.resolve(Buffer.from('// hosted helper fixture'))
        : originalRead(...args),
    )
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = root
    storageSet('activeProjectId', 'project')
    setApiKey('openai', 'adapter-test-key')
  })
  afterEach(() => {
    mock.restoreAll()
    restoreWorkspace()
    clearOpenAiAgentSession('thread')
    storageSet('activeProjectId', null)
    deleteApiKey('openai')
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('dispatches OpenAI, saves its checkpoint in the thread, projects tools, and downloads a safely named artifact', async () => {
    const imagePrompt = [{ type: 'image' as const, dataUrl: 'data:image/png;base64,aGVsbG8=' }]
    let submitted = false
    let failDownload = true
    let submissions = 0
    let base = ''
    const manifest = (): string => JSON.stringify({ base, head: base, changed: false })
    const requests: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      requests.push(url.pathname)
      assert.equal(url.origin, 'https://api.openai.com')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer adapter-test-key')
      if (url.pathname === '/v1/files') {
        assert.ok(init?.body instanceof FormData)
        assert.equal(init.body.get('purpose'), 'user_data')
        return Response.json({ id: 'source-file' })
      }
      if (url.pathname === '/v1/files/source-file') return Response.json({ deleted: true })
      if (url.pathname === '/v1/agents/environments/env')
        return Response.json({ status: 'connected' })
      if (url.pathname === '/v1/agents/sessions') {
        assert.ok(typeof init?.body === 'string')
        const request = safeJsonParse(
          init.body,
          decodeWithSchema(
            z.object({
              environment: z.object({ setup_commands: z.array(z.object({ command: z.string() })) }),
            }),
          ),
        )
        assert.ok(request)
        base = request.environment.setup_commands[0]?.command.split(' ')[3] ?? ''
        assert.match(base, /^[a-f0-9]{40}$/)
      }
      if (url.pathname.endsWith('/events') && init?.method === 'GET')
        return new Response('', { headers: { 'Content-Type': 'text/event-stream' } })
      if (url.pathname.endsWith('/events')) {
        assert.ok(
          typeof init?.body === 'string' &&
            init.body.includes('input_image') &&
            init.body.includes('data:image/png;base64,aGVsbG8='),
        )
        submitted = true
        submissions++
        return new Response(null, { status: 202 })
      }
      if (url.pathname.endsWith('/turns'))
        return page(
          submitted ? [{ id: 'turn', status: 'completed', subagent_id: null, error: null }] : [],
        )
      if (url.pathname.endsWith('/items'))
        return page([
          {
            id: 'command',
            turn_id: 'turn',
            type: 'command_execution',
            status: 'completed',
            command: 'python hello.py',
            output: '4',
            exit_code: 0,
          },
          {
            id: 'reply',
            turn_id: 'turn',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'The script printed 4.' }],
          },
          {
            id: 'tool',
            turn_id: 'turn',
            type: 'function_call_output',
            output: { type: 'json', value: { ok: true } },
          },
          { id: 'reasoning', turn_id: 'turn', type: 'reasoning', status: null, summary: [] },
        ])
      if (url.pathname.endsWith('/artifacts'))
        return page([
          {
            id: 'manifest',
            turn_id: 'turn',
            path: '/workspace/outputs/copse-result.json',
            size_bytes: Buffer.byteLength(manifest()),
          },
          { id: '../../escape', turn_id: 'turn', path: '../../escape.txt', size_bytes: 4 },
        ])
      if (url.pathname.endsWith('/manifest/content')) {
        if (failDownload) {
          failDownload = false
          return new Response(null, { status: 503 })
        }
        return new Response(manifest())
      }
      if (url.pathname.endsWith('/content')) return new Response('file')
      return Response.json({
        id: 'session',
        environment: { id: 'env' },
        status: 'idle',
        usage: { input_tokens: 12, output_tokens: 3 },
      })
    }
    const chunks: StreamChunk[] = []
    await assert.rejects(
      runRemoteAgentFromSettings({
        threadId: 'thread',
        provider: 'openai',
        userPrompt: imagePrompt,
        signal: AbortSignal.timeout(10_000),
        fetchImpl,
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      }),
      /503/,
    )
    await assert.rejects(
      runRemoteAgentFromSettings({
        threadId: 'thread',
        provider: 'openai',
        userPrompt: [{ type: 'image', dataUrl: 'data:image/png;base64,Ynl0ZXM=' }],
        signal: AbortSignal.timeout(10_000),
        fetchImpl,
        onChunk: () => {},
      }),
      /previous hosted task/,
    )
    const result = await runRemoteAgentFromSettings({
      threadId: 'thread',
      provider: 'openai',
      userPrompt: imagePrompt,
      signal: AbortSignal.timeout(10_000),
      fetchImpl,
      onChunk: (chunk) => {
        chunks.push(chunk)
      },
    })
    assert.match(result.assistantText, /printed 4/)
    assert.doesNotMatch(result.assistantText, /billed to your API key|US session retention/)
    assert.equal(result.inputTokens, 0)
    assert.equal(submissions, 1)
    assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1)
    assert.ok(
      chunks.some((chunk) => chunk.type === 'tool_call' && chunk.toolCall.name === 'run_shell'),
    )
    assert.ok(
      chunks.some(
        (chunk) => chunk.type === 'tool_result' && chunk.result === '4' && !chunk.isError,
      ),
    )
    const match = result.assistantText.match(/\[Download artifact \(4 bytes\)\]\(([^)]+)\)/)
    assert.ok(match?.[1])
    const link = new URL(match[1])
    assert.equal(link.origin, 'https://api.openai.com')
    assert.match(decodeURIComponent(link.pathname), /openai:thread/)
    const artifactPath = link.searchParams.get('path')
    assert.ok(artifactPath)
    assert.equal((await readOpenAiArtifact('thread', artifactPath)).toString(), 'file')
    await assert.rejects(readOpenAiArtifact('thread', '../../secret'), /Invalid/)
    await assert.rejects(readOpenAiArtifact('other-thread', artifactPath), /unavailable/)
    const cachedFile = join(
      threadDirectoryPath('project', 'thread'),
      'blobs',
      'openai-artifacts',
      artifactPath,
    )
    rmSync(cachedFile)
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'private')
    symlinkSync(outside, cachedFile)
    await assert.rejects(readOpenAiArtifact('thread', artifactPath), /escaped/)
    const checkpoint = readFileSync(
      join(threadDirectoryPath('project', 'thread'), 'openai-agent-session.json'),
      'utf8',
    )
    assert.ok(!checkpoint.includes('adapter-test-key'))
    assert.equal(storageGet('openai-agent-owner:thread'), 'project')
    assert.equal(requests.filter((path) => path === '/v1/agents/sessions').length, 1)

    setApiKey('openai', 'different-key')
    await assert.rejects(
      runRemoteAgentFromSettings({
        threadId: 'thread',
        provider: 'openai',
        userPrompt: 'follow-up',
        signal: AbortSignal.timeout(1_000),
        fetchImpl,
        onChunk: () => {},
      }),
      /different OpenAI key/,
    )
    setApiKey('openai', 'adapter-test-key')
    writeFileSync(
      join(threadDirectoryPath('project', 'thread'), 'openai-agent-session.json'),
      '{broken',
    )
    await assert.rejects(
      runRemoteAgentFromSettings({
        threadId: 'thread',
        provider: 'openai',
        userPrompt: 'follow-up',
        signal: AbortSignal.timeout(1_000),
        fetchImpl,
        onChunk: () => {},
      }),
      /checkpoint/,
    )
  })
  it('imports exported commits and provisions fresh local code for the follow-up', async () => {
    let session = 0
    let turn = 0
    let guest = ''
    let base = ''
    let uploaded = Buffer.alloc(0)
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.pathname === '/v1/files') {
        assert.ok(init?.body instanceof FormData)
        const file = init.body.get('file')
        assert.ok(file instanceof Blob)
        uploaded = Buffer.from(await file.arrayBuffer())
        return Response.json({ id: 'source' })
      }
      if (url.pathname === '/v1/files/source') return Response.json({ deleted: true })
      if (url.pathname.endsWith('/environments/env')) return Response.json({ status: 'connected' })
      if (url.pathname === '/v1/agents/sessions') {
        session++
        turn = 0
        guest = join(root, `guest-${String(session)}`)
        mkdirSync(join(guest, 'inputs'), { recursive: true })
        writeFileSync(join(guest, 'inputs/source.part-0'), uploaded)
        assert.ok(typeof init?.body === 'string')
        const request = safeJsonParse(
          init.body,
          decodeWithSchema(
            z.object({
              environment: z.object({ setup_commands: z.array(z.object({ command: z.string() })) }),
            }),
          ),
        )
        const args = request?.environment.setup_commands[0]?.command.split(' ')
        base = args?.[3] ?? ''
        runHostedGitTransfer(guest, 'setup', base, args?.[4], Number(args?.[5]))
        if (session === 2)
          assert.equal(readFileSync(join(guest, 'repo/local.txt'), 'utf8'), 'fresh local code')
      }
      if (url.pathname.endsWith('/events')) {
        if (init?.method === 'GET') return new Response('')
        turn++
        if (turn === 1)
          writeFileSync(join(guest, 'repo/result.txt'), `hosted change ${String(session)}`)
        else {
          assert.ok(
            typeof init?.body === 'string' &&
              init.body.includes('Do not change code or repeat the previous task'),
          )
          runHostedGitTransfer(guest, 'export', base)
        }
        return new Response(null, { status: 202 })
      }
      if (url.pathname.endsWith('/turns'))
        return page(
          Array.from({ length: turn }, (_, i) => ({
            id: `turn-${String(i + 1)}`,
            status: 'completed',
            subagent_id: null,
          })),
        )
      if (url.pathname.endsWith('/items')) return page([])
      if (url.pathname.endsWith('/artifacts'))
        return page(
          turn < 2
            ? []
            : ['copse-result.json', 'copse.bundle'].map((name) => ({
                id: name,
                path: `/workspace/outputs/${name}`,
                size_bytes: readFileSync(join(guest, 'outputs', name)).byteLength,
                turn_id: 'turn-2',
              })),
        )
      if (url.pathname.endsWith('/content')) {
        const name = url.pathname.split('/').at(-2)
        assert.ok(name)
        return new Response(new Uint8Array(readFileSync(join(guest, 'outputs', name))))
      }
      return Response.json({
        id: `session-${String(session)}`,
        status: 'idle',
        environment: { id: 'env' },
        usage: { input_tokens: turn * 10, output_tokens: turn },
      })
    }
    const run = (prompt: string): ReturnType<typeof runRemoteAgentFromSettings> =>
      runRemoteAgentFromSettings({
        threadId: 'thread',
        provider: 'openai',
        userPrompt: prompt,
        signal: AbortSignal.timeout(10_000),
        fetchImpl,
        onChunk: () => {},
      })
    const first = await run('Make a change')
    assert.equal(first.inputTokens, 20)
    assert.equal(readFileSync(join(root, 'repo/result.txt'), 'utf8'), 'hosted change 1')
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: join(root, 'repo'),
        encoding: 'utf8',
      }).trim(),
      '',
    )
    writeFileSync(join(root, 'repo/local.txt'), 'fresh local code')
    execFileSync('git', ['add', '.'], { cwd: join(root, 'repo') })
    execFileSync('git', ['commit', '-m', 'local follow-up'], { cwd: join(root, 'repo') })
    await run('Another change')
    assert.equal(session, 2)
    assert.equal(readFileSync(join(root, 'repo/result.txt'), 'utf8'), 'hosted change 2')
  })
})
