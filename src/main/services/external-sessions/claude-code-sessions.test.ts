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

  it("titles a row with the CLI's latest saved name, then its own title, then the prompt", async () => {
    const file = (path: string): Parameters<typeof readClaudeCodeSessionHeader>[0] => ({
      source: 'claude-code',
      path,
      updatedAt: 1,
      bytes: 1,
    })
    const reminder = {
      type: 'text',
      text: '<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>',
    }
    const named = writeSession(ROOT, 'named', [
      user('u1', null, [reminder, { type: 'text', text: 'Look at all dependencies' }]),
      { type: 'ai-title', aiTitle: 'Dependency audit', sessionId: 'named' },
      { type: 'custom-title', customTitle: 'Dependency review', sessionId: 'named' },
      { type: 'custom-title', customTitle: 'Dependency review (renamed)', sessionId: 'named' },
    ])
    const aiTitled = writeSession(ROOT, 'ai', [
      user('u1', null, 'hello'),
      { type: 'ai-title', aiTitle: 'Markdown sanitizer divergence', sessionId: 'ai' },
    ])
    const untitled = writeSession(ROOT, 'plain', [
      user('u1', null, [reminder, { type: 'text', text: 'Look at all dependencies' }]),
    ])

    assert.equal(
      (await readClaudeCodeSessionHeader(file(named)))?.title,
      'Dependency review (renamed)',
    )
    assert.equal(
      (await readClaudeCodeSessionHeader(file(aiTitled)))?.title,
      'Markdown sanitizer divergence',
    )
    assert.equal(
      (await readClaudeCodeSessionHeader(file(untitled)))?.title,
      'Look at all dependencies',
    )
  })

  it('gives every parallel tool call its result, though only the last is on the branch', async () => {
    // Claude Code's layout: each call is its own line of one response, and each
    // result hangs off its own call; the turn continues from the last result.
    const path = writeSession(ROOT, 's1', [
      user('u1', null, 'Read both files'),
      assistant('c1', 'u1', 'msg_1', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
      ]),
      assistant('c2', 'c1', 'msg_1', [
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/b' } },
      ]),
      user('r1', 'c1', [{ type: 'tool_result', tool_use_id: 't1', content: 'A' }]),
      user('r2', 'c2', [{ type: 'tool_result', tool_use_id: 't2', content: 'B' }]),
      assistant('a2', 'r2', 'msg_2', [{ type: 'text', text: 'Both read.' }]),
    ])

    const session = await readClaudeCodeSession({
      source: 'claude-code',
      path,
      updatedAt: 1,
      bytes: 1,
    })

    assert.deepEqual(
      session?.messages[1]?.toolCalls.map((call) => [call.id, call.result]),
      [
        ['t1', 'A'],
        ['t2', 'B'],
      ],
    )
  })

  it('leaves out turns the CLI or its host started, and injected context', async () => {
    const path = writeSession(ROOT, 's1', [
      user('u1', null, 'Watch the CI'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'Watching.' }]),
      user('n1', 'a1', '<task-notification>\n<task-id>b1</task-id>\n</task-notification>', {
        turnOrigin: 'task_notification',
      }),
      user('n2', 'n1', '<ci-monitor-event>CI failed</ci-monitor-event>'),
      user('n3', 'n2', 'From another session', { turnOrigin: 'peer' }),
      assistant('a2', 'n3', 'msg_2', [{ type: 'text', text: 'CI failed; fixing.' }]),
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
        ['user', 'Watch the CI'],
        ['assistant', 'Watching.'],
        ['assistant', 'CI failed; fixing.'],
      ],
    )
  })

  it('carries on past a parent the file does not hold', async () => {
    const path = writeSession(ROOT, 's1', [
      user('u1', null, 'First task'),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'Done.' }]),
      // Long live sessions have links to lines that were never written.
      assistant('a2', 'missing', 'msg_2', [{ type: 'text', text: 'Next part.' }]),
      user('u2', 'a2', 'Second task'),
    ])

    const session = await readClaudeCodeSession({
      source: 'claude-code',
      path,
      updatedAt: 1,
      bytes: 1,
    })

    assert.deepEqual(
      session?.messages.map((message) => message.content),
      ['First task', 'Done.', 'Next part.', 'Second task'],
    )
  })

  it('keeps the brief a host wrote, without its injected context, and labels non-text results', async () => {
    const path = writeSession(ROOT, 's1', [
      user(
        'u1',
        null,
        '<system-reminder>\nYou are in a worktree.\n</system-reminder>\n\nBackground: fix the IPC crash',
        { turnOrigin: 'host_synthetic' },
      ),
      assistant('a1', 'u1', 'msg_1', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/shot.png' } },
        { type: 'tool_use', id: 't2', name: 'ToolSearch', input: { query: 'select:A,B' } },
      ]),
      user('r1', 'a1', [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: {} }] },
        {
          type: 'tool_result',
          tool_use_id: 't2',
          content: [
            { type: 'tool_reference', tool_name: 'A' },
            { type: 'tool_reference', tool_name: 'B' },
          ],
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
    assert.equal(session.messages[0]?.content, 'Background: fix the IPC crash')
    assert.deepEqual(
      session.messages[1]?.toolCalls.map((call) => call.result),
      ['[image]', 'Loaded 2 tools'],
    )
  })

  it('reads a title from inside a wrapper the host put around the prompt', async () => {
    const path = writeSession(ROOT, 's1', [
      user(
        'u1',
        null,
        '<wake reason="mention"><message>&lt;!-- reply 1 --&gt; Test &amp; review 4484</message></wake>',
      ),
    ])

    const header = await readClaudeCodeSessionHeader({
      source: 'claude-code',
      path,
      updatedAt: 1,
      bytes: 1,
    })

    assert.equal(header?.title, 'Test & review 4484')
  })

  it('skips a file with no prompt in it', async () => {
    const path = writeSession(ROOT, 's1', [{ ...base, type: 'summary', summary: 'x' }])
    assert.equal(
      await readClaudeCodeSession({ source: 'claude-code', path, updatedAt: 1, bytes: 1 }),
      null,
    )
  })
})
