import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { Message, Thread } from './thread-types.ts'
import { explodeThread, foldThread, idPathSegment, type FileToWrite } from './fold.ts'
import {
  SPINE_SCHEMA_VERSION,
  serializeSpineLine,
  type SpineHookRunLine,
  type ThreadMeta,
} from './spine-schema.ts'
import { serializeOkfMessage } from './okf-message.ts'
import {
  appendHookRun,
  appendMessage,
  createThread,
  loadProjectCatalog,
  loadProjectThreads,
  saveProjectThread,
} from './thread-store.ts'

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Ids a model endpoint or ACP agent could hand the store. */
const HOSTILE_IDS = [
  '../../../outside/pwn',
  '/absolute/pwn',
  '..\\..\\..\\outside\\win',
  'nul\0byte',
  'line\nbreak',
  '',
  '.',
  '..',
  'x'.repeat(5000),
  '~41',
]

const PLAIN_IDS = [
  'u1',
  'a1-tc',
  'call_Abc123XYZ',
  'toolu_01A09q90qw90lq917835lq9',
  '9b2f6c1e-1d2a-4f5e-8c3b-7a6d5e4f3c2b',
]

function thread(id: string, messages: Message[]): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

/** A message whose own id and tool-call/subagent ids are all `id`-derived. */
function messageWithIds(messageId: string, toolCallId: string, subagentId: string): Message {
  return {
    id: messageId,
    role: 'assistant',
    content: `content of ${JSON.stringify(messageId)}`,
    reasoning: 'thinking',
    contentBlocks: [{ type: 'text', text: 'block' }],
    images: ['data:image/png;base64,AAAA'],
    attachments: [{ kind: 'paste', label: 'p', content: 'pasted' }],
    createdAt: 5,
    toolCalls: [
      {
        id: toolCallId,
        name: 'explore',
        // Over the inline limit, so the args spill to their own blob.
        args: { prompt: 'p'.repeat(4096) },
        status: 'done',
        result: 'R',
        images: [{ dataUrl: 'data:image/png;base64,BBBB' }],
        content: [{ type: 'content', content: { type: 'text', text: 'acp' } }],
        subagent: {
          id: subagentId,
          kind: 'explore',
          status: 'done',
          prompt: 'p',
          summary: 's',
          messages: [
            { id: messageId, role: 'assistant', content: 'nested', toolCalls: [], createdAt: 6 },
          ],
        },
      },
    ],
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
}

describe('idPathSegment', () => {
  it('leaves plain ids unchanged so existing thread files keep their names', () => {
    for (const id of PLAIN_IDS) assert.equal(idPathSegment(id), id)
  })

  it('maps every hostile id to one distinct, bounded, separator-free segment', () => {
    const segments = HOSTILE_IDS.map(idPathSegment)
    for (const segment of segments) {
      assert.match(segment, /^~[A-Za-z0-9_~-]+$|^~$/)
      assert.ok(segment.length <= 160, `segment too long: ${String(segment.length)}`)
    }
    assert.equal(new Set(segments).size, segments.length)
    assert.equal(new Set([...segments, ...PLAIN_IDS]).size, segments.length + PLAIN_IDS.length)
  })
})

describe('explodeThread with hostile ids', () => {
  it('keeps every file inside the thread content dirs and folds back unchanged', () => {
    const messages = HOSTILE_IDS.map((id, i) =>
      // Distinct ids per message: duplicate ids share blob names by design.
      messageWithIds(id, `${id}#tc${String(i)}`, id),
    )
    const { spine, files } = explodeThread(messages, sha256)
    const threadDir = resolve('/thread')
    for (const file of files) {
      const full = resolve(threadDir, file.ref)
      const [top, ...rest] = relative(threadDir, full).split(sep)
      assert.ok(
        ['messages', 'blobs', 'subagents'].includes(top ?? '') && rest.length > 0,
        `${JSON.stringify(file.ref)} escapes the thread directory`,
      )
    }
    const contents = new Map(files.map((f: FileToWrite) => [f.ref, f.contents]))
    const meta: ThreadMeta = {
      id: 't',
      title: 't',
      status: 'idle',
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
    }
    const folded = foldThread(
      meta,
      spine,
      (ref) => {
        const body = contents.get(ref)
        if (body === undefined) throw new Error(`Missing ${ref}`)
        return body
      },
      { hash: sha256 },
    )
    assert.deepEqual(folded.messages, messages)
  })
})

describe('thread-store paths', () => {
  let root: string
  let workspace: string
  let outside: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-thread-paths-'))
    // `blobs/../../../outside` from <workspace>/<project>/<thread> lands here.
    workspace = join(root, 'ws')
    outside = join(workspace, 'outside')
    mkdirSync(outside, { recursive: true })
    process.env['COPSE_WORKSPACE_DIR'] = workspace
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  /** Every file the store wrote, relative to the workspace, outside thread `t1`. */
  function strayFiles(): string[] {
    return filesUnder(workspace).filter(
      (file) =>
        !file.startsWith(join('proj', 't1') + sep) && file !== join('proj', 'catalog.jsonl'),
    )
  }

  it('saves and reloads hostile ids without writing outside the thread', async () => {
    const t = thread(
      't1',
      HOSTILE_IDS.map((id, i) => messageWithIds(id, `${id}#tc${String(i)}`, id)),
    )
    await saveProjectThread('proj', t)
    assert.deepEqual(strayFiles(), [])
    const [loaded] = await loadProjectThreads('proj')
    assert.deepEqual(loaded, t)
  })

  it('appends hostile ids without writing outside the thread', async () => {
    await createThread('proj', thread('t1', []))
    const messages = HOSTILE_IDS.map((id, i) => messageWithIds(id, `${id}#tc${String(i)}`, id))
    for (const message of messages) await appendMessage('proj', 't1', message)
    assert.deepEqual(strayFiles(), [])
    const [loaded] = await loadProjectThreads('proj')
    assert.deepEqual(loaded?.messages, messages)
  })

  it('writes plain ids to the same file names as before', async () => {
    await saveProjectThread('proj', thread('t1', [messageWithIds('a1', 'a1-tc', 'sub1')]))
    const files = filesUnder(join(workspace, 'proj', 't1')).sort()
    for (const expected of [
      join('messages', 'a1.md'),
      join('messages', 'a1.reasoning.md'),
      join('blobs', 'a1.acp-content.json'),
      join('blobs', 'a1-img-0.dataurl'),
      join('blobs', 'a1-attachment-0.txt'),
      join('blobs', 'a1-tc.result.txt'),
      join('blobs', 'a1-tc.args.json'),
      join('blobs', 'a1-tc-img-0.dataurl'),
      join('blobs', 'a1-tc.acp-content.json'),
      join('subagents', 'sub1', 'events.jsonl'),
      join('subagents', 'sub1', 'messages', 'a1.md'),
    ]) {
      assert.ok(files.includes(expected), `missing ${expected}`)
    }
    const spine = readFileSync(join(workspace, 'proj', 't1', 'events.jsonl'), 'utf8')
    assert.ok(!spine.includes('"id":"sub1","kind"'), 'plain subagent ids add no spine field')
  })

  it('still loads a legacy thread whose blob names hold an unescaped id', async () => {
    const legacyId = 'call.1\nx'
    const original = thread('t1', [messageWithIds('a1', 'legacyid', 'sub1')])
    await saveProjectThread('proj', original)
    const dir = join(workspace, 'proj', 't1')
    // Rewrite to the shape an older build left for a newline-bearing id.
    for (const suffix of ['.result.txt', '.args.json', '-img-0.dataurl', '.acp-content.json']) {
      renameSync(
        join(dir, 'blobs', `legacyid${suffix}`),
        join(dir, 'blobs', `${legacyId}${suffix}`),
      )
    }
    const spinePath = join(dir, 'events.jsonl')
    writeFileSync(
      spinePath,
      readFileSync(spinePath, 'utf8').replaceAll('legacyid', JSON.stringify(legacyId).slice(1, -1)),
    )
    const [loaded] = await loadProjectThreads('proj')
    const toolCall = loaded?.messages[0]?.toolCalls[0]
    assert.ok(toolCall)
    assert.equal(toolCall.id, legacyId)
    assert.deepEqual(toolCall.args, { prompt: 'p'.repeat(4096) })
  })

  /** Save a one-message thread whose spine points the message body at `ref`. */
  async function threadWithContentRef(ref: string, body: string): Promise<void> {
    const message: Message = { id: 'u1', role: 'user', content: 'hi', toolCalls: [], createdAt: 1 }
    await saveProjectThread('proj', thread('t1', [message]))
    const [line] = explodeThread([message], sha256).spine
    assert.ok(line)
    writeFileSync(
      join(workspace, 'proj', 't1', 'events.jsonl'),
      `${serializeSpineLine({ ...line, content: { ref, sha256: sha256(body) } })}\n`,
    )
    rmSync(join(workspace, 'proj', 'catalog.jsonl'), { force: true })
  }

  // `outside` is only known once a test has started, hence the thunks.
  const crafted: Array<{ label: string; refOf: () => string }> = [
    { label: 'a relative traversal', refOf: () => '../../outside/secret.md' },
    { label: 'an absolute path', refOf: () => join(outside, 'secret.md') },
    { label: 'a thread sidecar', refOf: () => 'meta.json' },
  ]
  for (const { label, refOf } of crafted) {
    it(`refuses to read a spine ref that is ${label}`, async () => {
      const body = 'TOP SECRET'
      const okf = serializeOkfMessage(
        { type: 'Message', role: 'user', id: 'x', createdAt: 0 },
        body,
      )
      writeFileSync(join(outside, 'secret.md'), okf)
      await threadWithContentRef(refOf(), body)
      assert.deepEqual(await loadProjectThreads('proj'), [])
      const hits = await loadProjectCatalog('proj')
      assert.ok(!JSON.stringify(hits).includes(body))
    })
  }

  it('refuses to follow a subagent ref out of the thread', async () => {
    const t = thread('t1', [messageWithIds('a1', 'a1-tc', 'sub1')])
    await saveProjectThread('proj', t)
    const dir = join(workspace, 'proj', 't1')
    // A complete, hash-valid subagent tree, moved outside the thread.
    renameSync(join(dir, 'subagents', 'sub1'), join(outside, 'sub1'))
    const spinePath = join(dir, 'events.jsonl')
    writeFileSync(
      spinePath,
      readFileSync(spinePath, 'utf8').replace('"subagents/sub1/"', '"../../outside/sub1/"'),
    )
    assert.deepEqual(await loadProjectThreads('proj'), [])
  })

  it('rejects a thread id that is not one directory under its project', async () => {
    for (const id of ['../outside', '..', 'a/b', '/absolute']) {
      await assert.rejects(saveProjectThread('proj', thread(id, [messageWithIds('u1', 'tc', 's')])))
    }
    assert.deepEqual(strayFiles(), [])
  })

  it('rejects a hook-run blob ref that escapes the thread', async () => {
    const line: SpineHookRunLine = {
      v: SPINE_SCHEMA_VERSION,
      type: 'hook_run',
      id: 'h1',
      event: 'stop',
      hookId: 'hook',
      executor: 'command',
      startedAt: 0,
      durationMs: 1,
      exitCode: 0,
      parseOk: true,
      decision: { permission: 'deny' },
    }
    await createThread('proj', thread('t1', []))
    await assert.rejects(
      appendHookRun('proj', 't1', line, [{ ref: 'blobs/../../../outside/h.txt', contents: 'x' }]),
    )
    assert.deepEqual(strayFiles(), [])
  })
})
