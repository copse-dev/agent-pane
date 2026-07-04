import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { readFileTool, listDirTool, LIST_DIR_MAX_ENTRIES } from './file-tools.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { runWithAgentRunReadFileLimits } from '../services/agent-run-read-limits.ts'

import { normalizeToolExecuteResult, type ToolExecuteResult } from '@shared/types'

const TEST_READ_LIMITS = { maxLines: 150, maxChars: 12_000 }

function toolText(result: ToolExecuteResult): string {
  return normalizeToolExecuteResult(result).result
}

function runTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  return runWithAgentRunReadFileLimits(TEST_READ_LIMITS, () =>
    registry.execute(name, args, signal).then(toolText),
  )
}

describe('file tools', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let registry: ToolRegistry

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-file-tools-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    registry = new ToolRegistry()
    registry.register(readFileTool)
    registry.register(listDirTool)
    setPermissionGateForTests(async () => true)
  })

  afterEach(async () => {
    setPermissionGateForTests(null)
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('read_file strips UTF-8 BOM and normalizes CRLF', async () => {
    await writeFile(join(tempRoot, 'bom.txt'), '\ufeffline1\r\nline2\r\n', 'utf8')
    const result = await runTool(
      registry,
      'read_file',
      { path: 'bom.txt' },
      new AbortController().signal,
    )
    assert.match(result, /^line1\nline2/)
    assert.doesNotMatch(result, /^\uFEFF/)
  })

  it('read_file returns a friendly error without leaking errno or absolute path (#123)', async () => {
    const result = await runTool(
      registry,
      'read_file',
      { path: 'does-not-exist.txt' },
      new AbortController().signal,
    )
    assert.match(result, /File not found: does-not-exist\.txt/)
    assert.doesNotMatch(result, /ENOENT/)
    assert.doesNotMatch(result, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('read_file rejects an end_line below start_line (#123)', async () => {
    await writeFile(join(tempRoot, 'r.txt'), 'a\nb\nc\n', 'utf8')
    const result = await runTool(
      registry,
      'read_file',
      { path: 'r.txt', start_line: 3, end_line: 1 },
      new AbortController().signal,
    )
    assert.match(result, /Invalid range/)
  })

  it('read_file enforces the line cap even with an explicit end_line (#123)', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line${String(i + 1)}`).join('\n')
    await writeFile(join(tempRoot, 'big.txt'), lines + '\n', 'utf8')
    const result = await runTool(
      registry,
      'read_file',
      { path: 'big.txt', start_line: 1, end_line: 500 },
      new AbortController().signal,
    )
    const body = result.split('\n').filter((l) => /^line\d+$/.test(l))
    assert.ok(
      body.length <= TEST_READ_LIMITS.maxLines,
      `expected <= ${String(TEST_READ_LIMITS.maxLines)} lines, got ${String(body.length)}`,
    )
  })

  it('list_dir returns a friendly error for a missing directory (#123)', async () => {
    const result = await runTool(
      registry,
      'list_dir',
      { path: 'no/such/dir' },
      new AbortController().signal,
    )
    assert.match(result, /Directory not found: no\/such\/dir/)
    assert.doesNotMatch(result, /ENOENT/)
  })

  it('list_dir caps non-recursive entries', async () => {
    await mkdir(join(tempRoot, 'many'), { recursive: true })
    for (let i = 0; i < LIST_DIR_MAX_ENTRIES + 5; i++) {
      await writeFile(join(tempRoot, 'many', `f-${String(i)}.txt`), 'x', 'utf8')
    }
    const result = await runTool(
      registry,
      'list_dir',
      { path: 'many' },
      new AbortController().signal,
    )
    const lines = result.split('\n').filter((l) => l.startsWith('f '))
    assert.equal(lines.length, LIST_DIR_MAX_ENTRIES)
    assert.match(result, /\[Truncated at 1000 entries\]/)
  })

  it('list_dir recursive rg uses --no-follow and drops out-of-workspace symlinks', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'copse-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8')
    await mkdir(join(tempRoot, 'linked'), { recursive: true })
    await symlink(outside, join(tempRoot, 'linked', 'escape'))
    try {
      const result = await runTool(
        registry,
        'list_dir',
        { path: 'linked', recursive: true },
        new AbortController().signal,
      )
      assert.doesNotMatch(result, /secret\.txt/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('read tools on the read-only chat store (#644)', () => {
  let workspace = ''
  let chatRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let prevChatDir: string | undefined
  let registry: ToolRegistry
  let threadDir = ''

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'copse-ws-'))
    restoreWorkspace = setWorkspaceRootForTest(workspace)
    prevChatDir = process.env['COPSE_WORKSPACE_DIR']
    chatRoot = await mkdtemp(join(tmpdir(), 'copse-chat-'))
    process.env['COPSE_WORKSPACE_DIR'] = chatRoot
    threadDir = join(chatRoot, 'proj', 'thread')
    await mkdir(join(threadDir, 'messages'), { recursive: true })
    await writeFile(join(threadDir, 'messages', 'm.md'), 'past thread body\nsecond line\n', 'utf8')
    await writeFile(join(threadDir, 'events.jsonl'), '{"v":1}\n', 'utf8')
    registry = new ToolRegistry()
    registry.register(readFileTool)
    registry.register(listDirTool)
    setPermissionGateForTests(async () => true)
  })

  afterEach(async () => {
    setPermissionGateForTests(null)
    restoreWorkspace?.()
    if (prevChatDir === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = prevChatDir
    if (workspace) await rm(workspace, { recursive: true, force: true })
    if (chatRoot) await rm(chatRoot, { recursive: true, force: true })
  })

  it('read_file reads a chat-store file by absolute path', async () => {
    const result = await runTool(
      registry,
      'read_file',
      { path: join(threadDir, 'messages', 'm.md') },
      new AbortController().signal,
    )
    assert.match(result, /past thread body/)
  })

  it('list_dir (recursive) lists chat-store files by absolute path', async () => {
    const result = await runTool(
      registry,
      'list_dir',
      { path: threadDir, recursive: true },
      new AbortController().signal,
    )
    assert.match(result, /messages\/m\.md/)
    assert.match(result, /events\.jsonl/)
  })

  it('read_file still rejects paths outside both workspace and chat store', async () => {
    await assert.rejects(
      runTool(registry, 'read_file', { path: '/etc/hostname' }, new AbortController().signal),
      /outside workspace or chat store/,
    )
  })
})
