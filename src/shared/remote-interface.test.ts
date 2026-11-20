import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  remoteReadSchema,
  remoteReadAllowed,
  remoteScopeFromQuery,
  remoteStatePath,
  remoteViewSchema,
  REMOTE_READ_CHANNELS,
} from './remote-interface.ts'

describe('remote interface boundary', () => {
  it('does not expose native mutation, credential or rejected payload surfaces', () => {
    for (const channel of [
      'agent:run',
      'settings:set',
      'storage:set',
      'fs:read-file',
      'fs:write-file',
      'git:status',
      'git:current-branch',
      'diff:queue',
      'container:get-run',
      'security:get-guarded-yolo',
      'approval:respond',
      '__proto__',
      'constructor',
    ]) {
      assert.equal(
        remoteReadSchema.safeParse({ version: 1, channel, args: [] }).success,
        false,
        channel,
      )
    }
    assert.equal(new Set(REMOTE_READ_CHANNELS).size, REMOTE_READ_CHANNELS.length)
  })

  it('restricts settings and storage keys independently of the channel allowlist', () => {
    const read = (channel: 'settings:get' | 'storage:get', key: string): boolean =>
      remoteReadAllowed(remoteReadSchema.parse({ version: 1, channel, args: [key] }))
    assert.equal(read('settings:get', 'nextStepSuggestionEnabled'), true)
    assert.equal(read('settings:get', 'anthropicApiKey'), false)
    assert.equal(read('settings:get', 'registeredAcpAgents'), false)
    assert.equal(read('storage:get', 'projects'), true)
    assert.equal(read('storage:get', 'secrets'), false)
  })

  it('rejects unknown protocol versions and extra fields', () => {
    assert.equal(
      remoteReadSchema.safeParse({ version: 2, channel: 'skills:list', args: [] }).success,
      false,
    )
    assert.equal(
      remoteReadSchema.safeParse({ version: 1, channel: 'skills:list', args: [], sender: {} })
        .success,
      false,
    )
  })

  it('removes branch and execution metadata from published thread views', () => {
    const view = remoteViewSchema.parse({
      projectId: 'p',
      threads: [
        {
          id: 't',
          title: 'Chat',
          status: 'idle',
          createdAt: 1,
          updatedAt: 2,
          usage: { inputTokens: 0, outputTokens: 0 },
          messages: [],
          gitBranch: 'private-branch',
          worktree: { path: '/private/path' },
          executionMode: 'agent',
        },
      ],
    })
    assert.equal(Object.hasOwn(view.threads[0] ?? {}, 'gitBranch'), false)
    assert.equal(Object.hasOwn(view.threads[0] ?? {}, 'worktree'), false)
    assert.equal(Object.hasOwn(view.threads[0] ?? {}, 'executionMode'), false)
  })
})

describe('remote state scope', () => {
  const scopeOf = (path: string): ReturnType<typeof remoteScopeFromQuery> =>
    remoteScopeFromQuery(new URL(path, 'https://copse.invalid').searchParams)

  it('round-trips a scope through the request path', () => {
    assert.equal(remoteStatePath(), '/api/remote/state')
    assert.equal(scopeOf(remoteStatePath()), undefined)
    for (const scope of [{ projectId: 'proj-1' }, { projectId: 'proj-1', threadId: 'thread_2' }])
      assert.deepEqual(scopeOf(remoteStatePath(scope)), scope)
  })

  it('refuses a malformed scope instead of widening it to everything', () => {
    for (const query of [
      '?thread=t',
      '?project=',
      '?project=../other',
      '?project=p&thread=',
      '?project=p&thread=a/b',
      `?project=${'p'.repeat(129)}`,
    ])
      assert.equal(scopeOf(`/api/remote/state${query}`), null, query)
  })
})
