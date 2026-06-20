import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { readFileTool, listDirTool, LIST_DIR_MAX_ENTRIES } from './file-tools.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import {
  clearAgentRunReadFileLimits,
  setAgentRunReadFileLimitsExplicit,
} from '../services/agent-run-read-limits.ts'

describe('file tools', () => {
  let tempRoot = ''
  let restoreWorkspace: (() => void) | undefined
  let registry: ToolRegistry

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'copse-panel-file-tools-'))
    restoreWorkspace = setWorkspaceRootForTest(tempRoot)
    setAgentRunReadFileLimitsExplicit({ maxLines: 150, maxChars: 12_000 })
    registry = new ToolRegistry()
    registry.register(readFileTool)
    registry.register(listDirTool)
    setPermissionGateForTests(async () => true)
  })

  afterEach(async () => {
    setPermissionGateForTests(null)
    clearAgentRunReadFileLimits()
    restoreWorkspace?.()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it('read_file strips UTF-8 BOM and normalizes CRLF', async () => {
    await writeFile(join(tempRoot, 'bom.txt'), '\ufeffline1\r\nline2\r\n', 'utf8')
    const result = await registry.execute(
      'read_file',
      { path: 'bom.txt' },
      new AbortController().signal,
    )
    assert.match(result, /^line1\nline2/)
    assert.doesNotMatch(result, /^\uFEFF/)
  })

  it('list_dir caps non-recursive entries', async () => {
    await mkdir(join(tempRoot, 'many'), { recursive: true })
    for (let i = 0; i < LIST_DIR_MAX_ENTRIES + 5; i++) {
      await writeFile(join(tempRoot, 'many', `f-${i}.txt`), 'x', 'utf8')
    }
    const result = await registry.execute(
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
      const result = await registry.execute(
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
