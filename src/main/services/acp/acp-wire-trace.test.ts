import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AnyMessage,
  type RequestPermissionResponse,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { StreamChunk, Thread } from '@shared/types'
import { isRecord } from '@shared/unknown-value.ts'
import {
  ACP_WIRE_TRACE_FILE,
  ACP_WIRE_TRACE_VERSION,
  classifyWireMessage,
  createAcpWireTrace,
  drainAcpWireTrace,
  isAcpWireTraceEnabled,
} from './acp-wire-trace.ts'
import { tapAcpWireStream } from './acp-wire-tap.ts'
import { acquireAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'
import { runAcpSessionPrompt } from './acp-client.ts'
import { sessionUpdateToStreamChunk } from './session-update-adapter.ts'
import {
  loadProjectThreads,
  readThreadDirectory,
  saveProjectThread,
  threadDirectoryPath,
} from '../thread-store.ts'

/**
 * The opt-in ACP wire trace (`COPSE_DEBUG_ACP_UPDATES=1`). What matters here is
 * the *fidelity* claim: what an adapter puts on the wire is what lands in
 * `acp-debug.jsonl`, including fields the ACP schema does not model and Copse's
 * normalization discards. The disabled path is asserted just as hard — a
 * diagnostic that writes anything while switched off is a regression.
 */

const ON = { COPSE_DEBUG_ACP_UPDATES: '1' } as NodeJS.ProcessEnv
const OFF = {} as NodeJS.ProcessEnv

/**
 * The disputed shape: a generic display title, the real identity only in
 * `name`, and a vendor field ACP does not model — typed with the extension so
 * a real agent connection can actually put it on the wire.
 */
const GENERIC_MCP_TOOL_CALL: SessionUpdate & { vendorExtension: { serverName: string } } = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  title: 'MCP: tool',
  name: 'mcp__linear__create_issue',
  kind: 'other',
  status: 'pending',
  rawInput: { team: 'ENG' },
  _meta: { 'cursor.dev/serverName': 'linear' },
  vendorExtension: { serverName: 'linear' },
}

/**
 * A `tool_call` update carrying, alongside the standard fields, the three
 * things this facility exists to catch: an experimental programmatic `name`,
 * a populated `_meta`, and a vendor extension key ACP has never heard of.
 */
function toolCallUpdate(sessionId: string): AnyMessage {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'MCP: tool',
        name: 'mcp__linear__create_issue',
        kind: 'other',
        status: 'pending',
        rawInput: { team: 'ENG', title: 'bug' },
        rawOutput: { url: 'https://example.invalid/ENG-1' },
        content: [{ type: 'content', content: { type: 'text', text: 'creating' } }],
        locations: [{ path: '/repo/src/a.ts', line: 12 }],
        _meta: { 'cursor.dev/serverName': 'linear', 'cursor.dev/toolName': 'create_issue' },
        vendorExtension: { deeply: { nested: [1, 'two', null, true] } },
      },
    },
  }
}

function permissionRequest(sessionId: string): AnyMessage {
  return {
    jsonrpc: '2.0',
    id: 7,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        toolCallId: 'call-1',
        title: 'MCP: tool',
        name: 'mcp__linear__create_issue',
        kind: 'other',
        rawInput: { team: 'ENG' },
        _meta: { 'cursor.dev/serverName': 'linear' },
        vendorExtension: 'kept',
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
      _meta: { requestScopedExtension: true },
    },
  }
}

/** Every trace line for one file, parsed, in the order they were appended. */
function readTrace(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      assert.ok(isRecord(parsed), `every trace line should be a JSON object: ${line}`)
      return parsed
    })
}

/** Trace lines excluding the local `session` header, i.e. real wire messages. */
function wireRecords(path: string): Record<string, unknown>[] {
  return readTrace(path).filter((line) => line['dir'] === 'in')
}

/** Walk into a nested object by key, asserting each hop is really there. */
function at(value: unknown, ...keys: readonly string[]): Record<string, unknown> {
  let current = value
  for (const key of keys) {
    assert.ok(isRecord(current), `expected an object before reaching "${key}"`)
    current = current[key]
  }
  assert.ok(isRecord(current), `expected an object at ${keys.join('.')}`)
  return current
}

function threadOf(id: string): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

/** A stream whose readable replays `messages`, for driving the tap directly. */
function fakeStream(messages: readonly AnyMessage[]): Stream {
  return {
    readable: new ReadableStream<AnyMessage>({
      start(controller): void {
        for (const message of messages) controller.enqueue(message)
        controller.close()
      },
    }),
    writable: new WritableStream<AnyMessage>(),
  }
}

async function drainStream(stream: Stream): Promise<AnyMessage[]> {
  const seen: AnyMessage[] = []
  const reader = stream.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    seen.push(value)
  }
  return seen
}

describe('acp wire trace', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-acp-wire-trace-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(async () => {
    await drainAcpWireTrace()
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('is off unless the flag is exactly 1', () => {
    assert.equal(isAcpWireTraceEnabled(OFF), false)
    assert.equal(isAcpWireTraceEnabled({ COPSE_DEBUG_ACP_UPDATES: '0' }), false)
    assert.equal(isAcpWireTraceEnabled({ COPSE_DEBUG_ACP_UPDATES: 'true' }), false)
    assert.equal(isAcpWireTraceEnabled({ COPSE_DEBUG_ACP_UPDATES: '' }), false)
    assert.equal(isAcpWireTraceEnabled(ON), true)
  })

  it('writes nothing at all when the flag is off', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const dir = threadDirectoryPath('p1', 't1')

    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, OFF)
    assert.equal(trace, null)

    // The disabled tap must hand back the caller's own stream object, so the
    // transport is not merely equivalent but identical — no transform, no
    // serialization, no write.
    const stream = fakeStream([toolCallUpdate('s1')])
    assert.equal(tapAcpWireStream(stream, null), stream)
    assert.equal((await drainStream(stream)).length, 1)

    await drainAcpWireTrace()
    assert.equal(existsSync(join(dir, ACP_WIRE_TRACE_FILE)), false)
  })

  it('records a complete session/update payload, field for field', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(trace)

    const message = toolCallUpdate('s1')
    trace.record(message)
    await drainAcpWireTrace()

    const [record] = wireRecords(trace.path)
    assert.ok(record)
    assert.equal(record['v'], ACP_WIRE_TRACE_VERSION)
    assert.equal(record['type'], 'notification')
    assert.equal(record['method'], 'session/update')
    assert.equal(typeof record['ts'], 'string')
    // Not "the fields we thought to check" — the entire message, unchanged.
    assert.deepEqual(record['msg'], message)
  })

  it('keeps the experimental name, _meta, and unknown extension fields that normalization drops', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(trace)

    const message = toolCallUpdate('s1')
    trace.record(message)
    await drainAcpWireTrace()

    const [record] = wireRecords(trace.path)
    const update = at(record, 'msg', 'params', 'update')
    assert.equal(update['name'], 'mcp__linear__create_issue')
    assert.deepEqual(update['_meta'], {
      'cursor.dev/serverName': 'linear',
      'cursor.dev/toolName': 'create_issue',
    })
    assert.deepEqual(update['vendorExtension'], { deeply: { nested: [1, 'two', null, true] } })

    // The point of tracing the transport rather than the parsed update: by the
    // time Copse has a StreamChunk, the label is derived from `title` and the
    // programmatic name and vendor fields are gone. The trace still has them.
    const chunk = sessionUpdateToStreamChunk({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'MCP: tool',
      name: 'mcp__linear__create_issue',
      kind: 'other',
      rawInput: { team: 'ENG' },
    })
    assert.ok(chunk !== null && chunk.type === 'tool_call')
    assert.equal(chunk.toolCall.name, 'MCP: tool')
    assert.equal(JSON.stringify(chunk).includes('mcp__linear__create_issue'), false)
  })

  it('records a complete session/request_permission payload', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(trace)

    const message = permissionRequest('s1')
    trace.record(message)
    await drainAcpWireTrace()

    const [record] = wireRecords(trace.path)
    assert.ok(record)
    // A request carries an id, so it must not be filed as a notification.
    assert.equal(record['type'], 'request')
    assert.equal(record['method'], 'session/request_permission')
    assert.deepEqual(record['msg'], message)
  })

  it('classifies inbound shapes without consulting the ACP schema', () => {
    assert.deepEqual(classifyWireMessage({ method: 'session/update', params: {} }), {
      type: 'notification',
      method: 'session/update',
    })
    assert.deepEqual(classifyWireMessage({ id: 1, method: 'fs/read_text_file' }), {
      type: 'request',
      method: 'fs/read_text_file',
    })
    assert.deepEqual(classifyWireMessage({ id: 1, result: {} }), { type: 'response' })
    assert.deepEqual(classifyWireMessage({ id: 1, error: { code: -1 } }), { type: 'response' })
    assert.deepEqual(classifyWireMessage([{ id: 1, result: {} }]), { type: 'batch' })
    assert.deepEqual(classifyWireMessage('not a message'), { type: 'unknown' })
    // An unknown method is still recorded, under its own name — a vendor
    // notification carrying tool identity must not be filtered out.
    assert.deepEqual(classifyWireMessage({ method: 'cursor/toolMetadata' }), {
      type: 'notification',
      method: 'cursor/toolMetadata',
    })
  })

  it('preserves wire order across many updates, including between turns', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(trace)

    for (let i = 0; i < 40; i += 1) {
      trace.record({ jsonrpc: '2.0', method: 'session/update', params: { seq: i } })
    }
    await drainAcpWireTrace()
    // A second batch after the first flush settled — the between-turn case, on
    // a session that stays open. It must append, not truncate or reorder.
    for (let i = 40; i < 60; i += 1) {
      trace.record({ jsonrpc: '2.0', method: 'session/update', params: { seq: i } })
    }
    await drainAcpWireTrace()

    const seqs = wireRecords(trace.path).map((record) => at(record, 'msg', 'params')['seq'])
    assert.deepEqual(
      seqs,
      Array.from({ length: 60 }, (_, i) => i),
    )
  })

  it('appends in order when two sessions trace the same thread concurrently', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const a = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    const b = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(a)
    assert.ok(b)
    assert.equal(a.path, b.path)

    a.record({ method: 'session/update', params: { from: 'a' } })
    b.record({ method: 'session/update', params: { from: 'b' } })
    a.record({ method: 'session/update', params: { from: 'a' } })
    await drainAcpWireTrace()

    const froms = wireRecords(a.path).map((record) => at(record, 'msg', 'params')['from'])
    assert.deepEqual(froms, ['a', 'b', 'a'])
    // Two header lines, one per opened trace, and no lost wire lines.
    assert.equal(readTrace(a.path).filter((line) => line['type'] === 'session').length, 2)
  })

  it('taps the transport without changing what the SDK receives', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(trace)

    const messages = [toolCallUpdate('s1'), permissionRequest('s1')]
    const tapped = tapAcpWireStream(fakeStream(messages), trace)
    assert.deepEqual(await drainStream(tapped), messages)

    await drainAcpWireTrace()
    assert.deepEqual(
      wireRecords(trace.path).map((record) => record['msg']),
      messages,
    )
  })

  it('lands in the thread directory, beside events.jsonl', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(trace)
    trace.record({ method: 'session/update', params: {} })
    await drainAcpWireTrace()

    const dir = threadDirectoryPath('p1', 't1')
    assert.equal(trace.path, join(dir, ACP_WIRE_TRACE_FILE))
    assert.ok(existsSync(join(dir, 'events.jsonl')))
    assert.ok(existsSync(join(dir, ACP_WIRE_TRACE_FILE)))
    // Not in a sibling thread's directory, and not at the project root.
    assert.equal(existsSync(join(dir, '..', ACP_WIRE_TRACE_FILE)), false)
  })

  it('survives a full thread save and is ignored by loading', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(trace)
    trace.record(toolCallUpdate('s1'))
    await drainAcpWireTrace()
    const before = readFileSync(trace.path, 'utf8')

    // A full save rewrites the spine and prunes stale content; a root-level
    // sidecar must not be collateral.
    await saveProjectThread('p1', {
      ...threadOf('t1'),
      title: 'renamed',
      messages: [
        { id: 'm1', role: 'user', content: 'hi', toolCalls: [], createdAt: 10 },
        {
          id: 'm2',
          role: 'assistant',
          content: 'there',
          toolCalls: [{ id: 'tc1', name: 'read_file', args: {}, status: 'done', result: 'x' }],
          createdAt: 20,
        },
      ],
      updatedAt: 2,
    })
    assert.equal(readFileSync(trace.path, 'utf8'), before)

    // And replay does not see it: the thread loads exactly as saved, with no
    // extra messages or tool calls conjured from the diagnostic lines.
    const threads = await loadProjectThreads('p1')
    assert.equal(threads.length, 1)
    const [loaded] = threads
    assert.ok(loaded)
    assert.equal(loaded.title, 'renamed')
    assert.equal(loaded.messages.length, 2)
    assert.equal(JSON.stringify(loaded).includes('mcp__linear__create_issue'), false)
  })

  it('is carried out by a thread-directory archive export', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace({ threadId: 't1', projectId: 'p1' }, ON)
    assert.ok(trace)
    trace.record(toolCallUpdate('s1'))
    await drainAcpWireTrace()

    const files = await readThreadDirectory('p1', 't1')
    const traced = files.find((file) => file.path === ACP_WIRE_TRACE_FILE)
    assert.ok(traced, `archive should include ${ACP_WIRE_TRACE_FILE}`)
    assert.equal(
      Buffer.from(traced.data).toString('utf8'),
      readFileSync(trace.path, 'utf8'),
      'archived bytes should be the file verbatim',
    )
  })

  it('opens with a self-describing header naming the thread and agent', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace(
      {
        threadId: 't1',
        projectId: 'p1',
        agent: { command: 'cursor-agent', args: ['--acp'] },
      },
      ON,
    )
    assert.ok(trace)
    await drainAcpWireTrace()

    const [header] = readTrace(trace.path)
    assert.ok(header)
    assert.equal(header['v'], ACP_WIRE_TRACE_VERSION)
    assert.equal(header['dir'], 'meta')
    assert.equal(header['type'], 'session')
    assert.deepEqual(header['msg'], {
      threadId: 't1',
      projectId: 'p1',
      pid: process.pid,
      agent: { command: 'cursor-agent', args: ['--acp'] },
    })
  })

  // Observed on a real trace: `claude-agent-acp` takes its credential as an
  // argv entry, so an unmasked header put a live `sk-ant-oat01-…` token on line
  // 1 of a file whose whole purpose is to be handed to someone else. Wire
  // payloads stay verbatim; only our own spawn arguments are masked.
  it('masks credentials in the header without hiding which credential it was', async () => {
    await saveProjectThread('p1', threadOf('t1'))
    const trace = await createAcpWireTrace(
      {
        threadId: 't1',
        projectId: 'p1',
        agent: {
          command: 'claude-agent-acp',
          args: [
            'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-L-P7k9FA53kxXZZntKT2gIzAewR9Vee',
            '--model',
            'sonnet',
            'sk-ant-api03-bare-value',
          ],
        },
      },
      ON,
    )
    assert.ok(trace)
    await drainAcpWireTrace()

    const [header] = readTrace(trace.path)
    assert.deepEqual(header?.['msg'], {
      threadId: 't1',
      projectId: 'p1',
      pid: process.pid,
      agent: {
        command: 'claude-agent-acp',
        args: ['CLAUDE_CODE_OAUTH_TOKEN=<redacted>', '--model', 'sonnet', '<redacted>'],
      },
    })
    assert.ok(!JSON.stringify(header).includes('sk-ant-'))
  })
})

/**
 * The same claim, but through the wiring rather than around it: a real pooled
 * session, a real `session/prompt` turn, an in-memory agent sending the exact
 * shape Cursor is accused of sending. The unit tests above prove the sink is
 * faithful; this proves the sink is actually connected.
 */
describe('acp wire trace (session pool integration)', () => {
  let root: string
  let previousRoot: string | undefined
  let previousFlag: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    previousFlag = process.env['COPSE_DEBUG_ACP_UPDATES']
    root = mkdtempSync(join(tmpdir(), 'copse-acp-wire-e2e-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(async () => {
    await disposeAllAcpSessions()
    await drainAcpWireTrace()
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    if (previousFlag === undefined) delete process.env['COPSE_DEBUG_ACP_UPDATES']
    else process.env['COPSE_DEBUG_ACP_UPDATES'] = previousFlag
    rmSync(root, { recursive: true, force: true })
  })

  /** An agent that reports one MCP call the way Cursor is reported to. */
  function cursorLikeTransport(): () => Promise<{
    stream: ReturnType<typeof ndJsonStream>
    dispose: () => void
  }> {
    return () => {
      const c2a = new TransformStream<Uint8Array, Uint8Array>()
      const a2c = new TransformStream<Uint8Array, Uint8Array>()
      const connection = agent({ name: 'fake-cursor' })
        .onRequest('initialize', () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { promptCapabilities: { image: false } },
        }))
        .onRequest('session/new', () => ({ sessionId: 'sess-1' }))
        .onRequest('session/prompt', async (ctx) => {
          await ctx.client.notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: GENERIC_MCP_TOOL_CALL,
          })
          return { stopReason: 'end_turn' as const }
        })
        .onNotification('session/cancel', () => {})
        .connect(ndJsonStream(a2c.writable, c2a.readable))
      return Promise.resolve({
        stream: ndJsonStream(c2a.writable, a2c.readable),
        dispose: (): void => {
          connection.close()
        },
      })
    }
  }

  async function runOneTurn(): Promise<StreamChunk[]> {
    await saveProjectThread('proj-1', threadOf('thread-1'))
    const { entry } = await acquireAcpSession({
      threadId: 'thread-1',
      config: { command: 'fake-cursor', cwd: root },
      createTransport: cursorLikeTransport(),
    })
    const chunks: StreamChunk[] = []
    entry.open.handlers.current = {
      onChunk: (chunk): void => {
        chunks.push(chunk)
      },
      requestPermission: (): Promise<RequestPermissionResponse> =>
        Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    }
    const stop = await runAcpSessionPrompt(entry.open, 'make a linear issue', undefined)
    assert.equal(stop.stopReason, 'end_turn')
    await disposeAllAcpSessions()
    await drainAcpWireTrace()
    return chunks
  }

  it('captures what Copse discards, on a real turn, in the thread directory', async () => {
    process.env['COPSE_DEBUG_ACP_UPDATES'] = '1'
    const chunks = await runOneTurn()

    // What the user sees today: the generic label, and no trace of the real
    // tool identity anywhere in the normalized stream.
    const toolChunk = chunks.find((chunk) => chunk.type === 'tool_call')
    assert.ok(toolChunk)
    assert.equal(toolChunk.toolCall.name, 'MCP: tool')
    assert.equal(JSON.stringify(chunks).includes('mcp__linear__create_issue'), false)

    // What the diagnostic recovers, from the same turn.
    const traced = join(root, 'proj-1', 'thread-1', ACP_WIRE_TRACE_FILE)
    assert.ok(existsSync(traced), 'the trace should sit in the thread directory')
    const update = at(
      wireRecords(traced).find((record) => record['method'] === 'session/update'),
      'msg',
      'params',
      'update',
    )
    assert.equal(update['title'], 'MCP: tool')
    assert.equal(update['name'], 'mcp__linear__create_issue')
    assert.deepEqual(update['_meta'], { 'cursor.dev/serverName': 'linear' })
    assert.deepEqual(update['vendorExtension'], { serverName: 'linear' })
  })

  it('leaves no trace behind on the same turn with the flag unset', async () => {
    delete process.env['COPSE_DEBUG_ACP_UPDATES']
    const chunks = await runOneTurn()

    // Identical rendering — the diagnostic changes nothing about the turn.
    const toolChunk = chunks.find((chunk) => chunk.type === 'tool_call')
    assert.ok(toolChunk)
    assert.equal(toolChunk.toolCall.name, 'MCP: tool')
    assert.equal(existsSync(join(root, 'proj-1', 'thread-1', ACP_WIRE_TRACE_FILE)), false)
  })
})
