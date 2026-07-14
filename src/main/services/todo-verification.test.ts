import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAllowedWorkspaceRootsForTest,
  registerAllowedWorkspaceRoot,
  setWorkspaceRootForTest,
} from './workspace.ts'
import { verifyTodoCheck } from './todo-verification.ts'

describe('verifyTodoCheck', () => {
  let cleanupRoot: (() => void) | undefined

  beforeEach(() => {
    clearAllowedWorkspaceRootsForTest()
  })

  afterEach(() => {
    cleanupRoot?.()
    cleanupRoot = undefined
    clearAllowedWorkspaceRootsForTest()
  })

  it('fileExists rejects paths outside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-todo-'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)

    const result = await verifyTodoCheck(
      { kind: 'fileExists', path: '../../../etc/passwd' },
      new AbortController().signal,
    )

    assert.equal(result.passed, false)
    assert.match(result.detail, /outside workspace/)
  })

  it('fileExists passes for a file under the workspace root', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-todo-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'ok.ts'), 'ok')
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)

    const result = await verifyTodoCheck(
      { kind: 'fileExists', path: 'src/ok.ts' },
      new AbortController().signal,
    )

    assert.equal(result.passed, true)
    assert.match(result.detail, /File exists/)
  })
})
