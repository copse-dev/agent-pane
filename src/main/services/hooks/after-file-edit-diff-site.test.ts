// B2 fire-site wiring test: prove `afterFileEdit` fires at the diff-queue /
// write-tool site (`applyDiffEntry` write path), blocking by default, gated
// behind `cursorHooksEnabled`, and only for content writes (not delete/rename).
//
// Separate from `after-file-edit.test.ts` (which pins the orchestrator + matcher
// contract) because this one drives the real diff-queue apply path and toggles
// the `cursorHooksEnabled` setting through the test shim.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyDiffEntry, clearDiffQueueForTest } from '../diff-queue.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setSetting } from '../storage/settings.ts'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'

describe('afterFileEdit fires at the diff-queue write site (B2)', () => {
  let tempHome = ''
  let workspaceRoot = ''
  let originalHome: string | undefined
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-after-edit-site-home-'))
    workspaceRoot = await mkdtemp(join(tmpdir(), 'copse-after-edit-site-ws-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    restoreWorkspace = setWorkspaceRootForTest(workspaceRoot)
    resetCursorHookSessionErrorsForTest()
    setCursorHookTimeoutForTest(2_000)
    clearDiffQueueForTest()
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCursorHookTimeoutForTest()
    await setSetting('cursorHooksEnabled', false)
    restoreWorkspace?.()
    clearDiffQueueForTest()
    await rm(tempHome, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  async function writeMarkerHook(marker: string): Promise<void> {
    const script = join(tempHome, 'mark.sh')
    await writeFile(script, `#!/bin/sh\ncat > /dev/null\n: > '${marker}'\n`, 'utf-8')
    await chmod(script, 0o755)
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(
      userHooksConfigPath(),
      JSON.stringify({ hooks: { afterFileEdit: [{ command: script }] } }),
      'utf-8',
    )
  }

  it('fires (blocking) after a successful write when cursorHooksEnabled is on', async () => {
    const marker = join(tempHome, 'edited.marker')
    await writeMarkerHook(marker)
    await setSetting('cursorHooksEnabled', true)

    const result = await applyDiffEntry({
      path: 'src/app.ts',
      before: '',
      after: 'export const x = 1\n',
      language: 'typescript',
    })
    assert.deepEqual(result, { status: 'written' })
    // applyDiffEntry awaited the hook before returning, so the marker exists.
    assert.equal(existsSync(marker), true)
  })

  it('does not fire when cursorHooksEnabled is off (default)', async () => {
    const marker = join(tempHome, 'edited-off.marker')
    await writeMarkerHook(marker)
    // Setting left at its default (off).

    const result = await applyDiffEntry({
      path: 'src/app.ts',
      before: '',
      after: 'export const x = 1\n',
      language: 'typescript',
    })
    assert.deepEqual(result, { status: 'written' })
    assert.equal(existsSync(marker), false)
  })

  it('does not fire on a conflict (no write landed)', async () => {
    const marker = join(tempHome, 'conflict.marker')
    await writeMarkerHook(marker)
    await setSetting('cursorHooksEnabled', true)

    // On-disk content differs from the staged `before`, so the write is refused.
    await writeFile(join(workspaceRoot, 'a.txt'), 'formatted\n', 'utf-8')
    const result = await applyDiffEntry({
      path: 'a.txt',
      before: 'original\n',
      after: 'updated\n',
      language: 'plaintext',
    })
    assert.equal(result.status, 'conflict')
    assert.equal(existsSync(marker), false)
  })

  it('does not fire for a delete op (not a content edit)', async () => {
    const marker = join(tempHome, 'delete.marker')
    await writeMarkerHook(marker)
    await setSetting('cursorHooksEnabled', true)

    await writeFile(join(workspaceRoot, 'gone.txt'), 'bye\n', 'utf-8')
    const result = await applyDiffEntry({
      path: 'gone.txt',
      before: 'bye\n',
      after: '',
      language: 'plaintext',
      op: 'delete',
    })
    assert.deepEqual(result, { status: 'written' })
    assert.equal(existsSync(marker), false)
  })
})
