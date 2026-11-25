import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeProjectDirName,
  listClaudeCodeSessionFiles,
  readClaudeCodeSession,
  readClaudeCodeSessionHeader,
} from './claude-code-sessions.ts'

let configDir: string
const ROOT = '/Users/dev/code/my-app'

function writeSession(cwd: string, id: string, lines: unknown[]): string {
  const dir = join(configDir, 'projects', claudeProjectDirName(cwd))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return path
}

const base = { sessionId: 's1', cwd: ROOT, gitBranch: 'main', isSidechain: false }

function user(uuid: string, parentUuid: string | null, content: unknown, extra = {}): unknown {
  return {
    ...base,
    type: 'user',
    uuid,
    parentUuid,
    timestamp: '2026-11-01T10:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  }
}

function assistant(uuid: string, parentUuid: string, id: string, content: unknown[]): unknown {
  return {
    ...base,
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: '2026-11-01T10:00:05.000Z',
    message: { id, role: 'assistant', model: 'claude-sonnet-4-5', content },
  }
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'claude-sessions-'))
})
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe('Claude Code sessions', () => {
  it('lists sessions filed under the project folder or a folder inside it', async () => {
    writeSession(ROOT, 'a', [user('u1', null, 'hello')])
    writeSession(join(ROOT, 'packages/web'), 'b', [user('u1', null, 'hi')])
    writeSession('/Users/dev/code/other', 'c', [user('u1', null, 'nope')])
    writeSession(ROOT, 'agent-1234', [user('u1', null, 'side chain')])

    const files = await listClaudeCodeSessionFiles(ROOT, configDir)

    assert.deepEqual(files?.map((file) => file.path.split('/').at(-1)).sort(), [
      'a.jsonl',
      'b.jsonl',
    ])
  })

  it('says when there is no Claude Code folder at all', async () => {
    assert.equal(await listClaudeCodeSessionFiles(ROOT, join(configDir, 'missing')), null)
  })

  it('reads the list row from the first prompt the user typed', async () => {
    const path = writeSession(ROOT, 's1', [
      user('m', null, '<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
      user('u1', 'm', '  Fix the   login\nbutton on Safari  '),
    ])
    const header = await readClaudeCodeSessionHeader({
      source: 'claude-code',
      path,
      updatedAt: 1,
      bytes: 1,
    })
    assert.ok(header)
    assert.equal(header.title, 'Fix the login button on Safari')
    assert.equal(header.cwd, ROOT)
    assert.equal(header.gitBranch, 'main')
    assert.equal(header.sessionId, 's1')
  })

  it('turns the active branch into a transcript with tool calls and their results', async () => {
    const path = writeSession(ROOT, 's1', [
      user('u1', null, 'List the files'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'thinking', thinking: 'Use ls.' }]),
      assistant('a2', 'a1', 'msg_1', [
        { type: 'text', text: 'Listing them.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } },
      ]),
      user('r1', 'a2', [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\nsrc' },
      ]),
      assistant('a3', 'r1', 'msg_2', [{ type: 'text', text: 'Two entries.' }]),
      // A rewound attempt: the user edited their next prompt, leaving this branch behind.
      user('old', 'a3', 'Delete everything'),
      user('u2', 'a3', [
        {
          type: 'text',
          text: '<command-name>/review</command-name><command-args>src</command-args>',
        },
      ]),
      { ...base, type: 'summary', summary: 'Listing files', leafUuid: 'u2' },
      user('side', 'u2', 'subagent prompt', { isSidechain: true }),
    ])

    const session = await readClaudeCodeSession({
      source: 'claude-code',
      path,
      updatedAt: 1,
      bytes: 1,
    })

    assert.ok(session)
    assert.deepEqual(
      session.messages.map((message) => [message.role, message.content]),
      [
        ['user', 'List the files'],
        ['assistant', 'Listing them.'],
        ['assistant', 'Two entries.'],
        ['user', '/review src'],
      ],
    )
    const step = session.messages[1]
    assert.ok(step)
    assert.equal(step.reasoning, 'Use ls.')
    assert.equal(step.model, 'claude-sonnet-4-5')
    assert.deepEqual(step.toolCalls, [
      {
        id: 'toolu_1',
        name: 'Bash',
        title: 'ls -la',
        programmaticName: 'Bash',
        args: { command: 'ls -la' },
        status: 'done',
        result: 'README.md\nsrc',
        kind: 'execute',
      },
    ])
  })

  it('follows a turn through the attachment lines current Claude Code links it with', async () => {
    const attachment = (uuid: string, parentUuid: string): unknown => ({
      ...base,
      type: 'attachment',
      uuid,
      parentUuid,
      timestamp: '2026-11-01T10:00:01.000Z',
      attachment: { type: 'hook_additional_context', content: [] },
    })
    const path = writeSession(ROOT, 's1', [
      user('u1', null, 'Remember the codeword PLUM-42'),
      attachment('x1', 'u1'),
      attachment('x2', 'x1'),
      assistant('a1', 'x2', 'msg_1', [{ type: 'text', text: 'Noted.' }]),
    ])

    const session = await readClaudeCodeSession({
      source: 'claude-code',
      path,
      updatedAt: 1,
      bytes: 1,
    })

    assert.deepEqual(
      session?.messages.map((message) => [message.role, message.content]),
      [
        ['user', 'Remember the codeword PLUM-42'],
        ['assistant', 'Noted.'],
      ],
    )
  })

  it('marks a failed tool call and keeps pasted images', async () => {
    const path = writeSession(ROOT, 's1', [
      user('u1', null, [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]),
      assistant('a1', 'u1', 'msg_1', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      ]),
      user('r1', 'a1', [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          is_error: true,
          content: [{ type: 'text', text: 'ENOENT' }],
        },
      ]),
    ])

    const session = await readClaudeCodeSession({
      source: 'claude-code',
      path,
      updatedAt: 1,
      bytes: 1,
    })

    assert.ok(session)
    assert.deepEqual(session.messages[0]?.images, ['data:image/png;base64,AAAA'])
    const call = session.messages[1]?.toolCalls[0]
    assert.ok(call)
    assert.equal(call.status, 'error')
    assert.equal(call.result, 'ENOENT')
    assert.equal(call.title, 'Read /x')
  })

  it('skips a file with no prompt in it', async () => {
    const path = writeSession(ROOT, 's1', [{ ...base, type: 'summary', summary: 'x' }])
    assert.equal(
      await readClaudeCodeSession({ source: 'claude-code', path, updatedAt: 1, bytes: 1 }),
      null,
    )
  })
})
