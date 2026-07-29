// Contract tests for the F2 Copse-native diff-queue events.
//
// Two fire sites, both driven through the real Copse `~/.copse/hooks.json`
// discovery → registry → runner → adapter seam:
//   - `beforeDiffApply` (blocking): a `deny` blocks a queued/direct diff apply;
//     a glob matcher scopes which paths a hook gates; the diff-queue wiring
//     (`applyDiffEntry`) turns a block into a failed `ApplyResult` and is gated
//     behind `cursorHooksEnabled`.
//   - `afterDiffApply` (async, detached): fires at the terminal-decision choke
//     point (`recordDecision`) with `applied` true on approve, false on reject —
//     never awaited (decision 3), so the site test polls for the hook's output.
//
// House style mirrors `stop.test.ts` (async orchestrator) and
// `after-file-edit-diff-site.test.ts` (the diff-queue wiring).
import { describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ownedIt } from '../thread-execution-context.test-support.ts'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import {
  userCopseHooksConfigPath,
  resetCopseHookSessionErrorsForTest,
  setCopseHookTimeoutForTest,
} from './copse-adapter.ts'
import { runBeforeDiffApplyHooks, runAfterDiffApplyHooks } from './diff-apply.ts'
import {
  applyDiffEntry,
  stageDiff,
  setStagedDiffResolver,
  clearDiffQueueForTest,
} from '../diff-queue.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setSetting } from '../storage/settings.ts'

let threadCounter = 0

/**
 * Poll until `path` exists (a detached hook wrote it) or the deadline passes.
 *
 * Existence is a safe completion signal only because `writeCaptureHook` renames
 * the file into place once its stdin is fully copied.
 */
async function waitForFile(path: string, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return existsSync(path)
}

describe('diff-apply Copse-native events (F2)', () => {
  let tempHome = ''
  let workspaceRoot = ''
  let originalHome: string | undefined
  let restoreWorkspace: (() => void) | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-diff-apply-home-'))
    workspaceRoot = await mkdtemp(join(tmpdir(), 'copse-diff-apply-ws-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    restoreWorkspace = setWorkspaceRootForTest(workspaceRoot)
    resetCopseHookSessionErrorsForTest()
    setCopseHookTimeoutForTest(2_000)
    clearDiffQueueForTest()
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCopseHookTimeoutForTest()
    setStagedDiffResolver(null)
    await setSetting('cursorHooksEnabled', false)
    restoreWorkspace?.()
    clearDiffQueueForTest()
    await rm(tempHome, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  })

  async function writeUserCopseHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.copse'), { recursive: true })
    await writeFile(userCopseHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  /** Executable script that prints `responseJson` on stdout. */
  async function writeResponseHook(name: string, responseJson: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${responseJson}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  /**
   * Executable script that copies its stdin to `stdinFile`.
   *
   * Writes to a sibling temp path and renames, so `stdinFile` only ever appears
   * complete: a plain `cat > stdinFile` creates the file when the shell sets up
   * the redirect, before any bytes are copied, and the detached-hook tests below
   * poll for existence — they would otherwise read an empty file and fail in
   * `JSON.parse`.
   */
  async function writeCaptureHook(name: string, stdinFile: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(
      path,
      `#!/bin/sh\ncat > '${stdinFile}.partial'\nmv '${stdinFile}.partial' '${stdinFile}'\n`,
      'utf-8',
    )
    await chmod(path, 0o755)
    return path
  }

  describe('runBeforeDiffApplyHooks (blocking)', () => {
    ownedIt('returns not-blocked when no hooks match', async () => {
      const decision = await runBeforeDiffApplyHooks('/abs/src/app.ts', {
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.deepEqual(decision, { blocked: false })
    })

    ownedIt('blocks the apply on a hook deny, surfacing the agent message', async () => {
      const script = await writeResponseHook(
        'deny.sh',
        '{"decision":"deny","agentMessage":"secrets not allowed"}',
      )
      await writeUserCopseHooks({ hooks: { beforeDiffApply: [{ command: script }] } })

      const decision = await runBeforeDiffApplyHooks('/abs/src/app.ts', {
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(decision.blocked, true)
      assert.equal(decision.agentMessage, 'secrets not allowed')
    })

    ownedIt('treats a hook `ask` as a block (a diff apply cannot pause for approval)', async () => {
      const script = await writeResponseHook('ask.sh', '{"decision":"ask"}')
      await writeUserCopseHooks({ hooks: { beforeDiffApply: [{ command: script }] } })

      const decision = await runBeforeDiffApplyHooks('/abs/src/app.ts', {
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(decision.blocked, true)
    })

    ownedIt('honours a path glob — a non-matching path is not gated', async () => {
      const script = await writeResponseHook('deny-ts.sh', '{"decision":"deny"}')
      await writeUserCopseHooks({
        hooks: { beforeDiffApply: [{ command: script, glob: '*.ts' }] },
      })

      const blocked = await runBeforeDiffApplyHooks('/abs/src/app.ts', {
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(blocked.blocked, true)

      const notBlocked = await runBeforeDiffApplyHooks('/abs/src/app.js', {
        workspaceRoot: null,
        projectTrusted: false,
      })
      assert.equal(notBlocked.blocked, false)
    })
  })

  describe('runAfterDiffApplyHooks (async, detached)', () => {
    ownedIt('returns ran:0 when no hooks match', async () => {
      const result = await runAfterDiffApplyHooks(
        { filePath: '/abs/src/app.ts', applied: true },
        {
          threadId: `after-diff-${String(threadCounter++)}`,
          turnTreeId: asTurnTreeId('t'),
          workspaceRoot: null,
          projectTrusted: false,
        },
      )
      assert.equal(result.ran, 0)
      await result.settled
    })

    ownedIt('dispatches the hook with the applied flag on stdin', async () => {
      const stdinFile = join(tempHome, 'after.json')
      const script = await writeCaptureHook('after.sh', stdinFile)
      await writeUserCopseHooks({ hooks: { afterDiffApply: [{ command: script }] } })

      const result = await runAfterDiffApplyHooks(
        { filePath: '/abs/src/app.ts', applied: false },
        {
          threadId: `after-diff-${String(threadCounter++)}`,
          turnTreeId: asTurnTreeId('t'),
          workspaceRoot: null,
          projectTrusted: false,
        },
      )
      assert.equal(result.ran, 1)
      await result.settled
      const stdin = expectRecord(parseJsonUnknown(readFileSync(stdinFile, 'utf-8')))
      assert.equal(stdin['applied'], false)
      assert.equal(stdin['file_path'], '/abs/src/app.ts')
    })
  })

  describe('diff-queue wiring', () => {
    ownedIt('a beforeDiffApply deny fails the apply (gated on cursorHooksEnabled)', async () => {
      const script = await writeResponseHook('block.sh', '{"decision":"deny","agentMessage":"no"}')
      await writeUserCopseHooks({ hooks: { beforeDiffApply: [{ command: script }] } })
      await setSetting('cursorHooksEnabled', true)

      const result = await applyDiffEntry({
        path: 'src/app.ts',
        before: '',
        after: 'export const x = 1\n',
        language: 'typescript',
      })
      assert.equal(result.status, 'error')
      assert.equal(existsSync(join(workspaceRoot, 'src/app.ts')), false)
    })

    ownedIt('does not block the apply when cursorHooksEnabled is off (default)', async () => {
      const script = await writeResponseHook('block.sh', '{"decision":"deny"}')
      await writeUserCopseHooks({ hooks: { beforeDiffApply: [{ command: script }] } })
      // Setting left at its default (off).

      const result = await applyDiffEntry({
        path: 'src/app.ts',
        before: '',
        after: 'export const x = 1\n',
        language: 'typescript',
      })
      assert.deepEqual(result, { status: 'written' })
    })

    ownedIt('afterDiffApply fires with applied:false on a reject (headless resolver)', async () => {
      const stdinFile = join(tempHome, 'rejected.json')
      const script = await writeCaptureHook('after-reject.sh', stdinFile)
      await writeUserCopseHooks({ hooks: { afterDiffApply: [{ command: script }] } })
      await setSetting('cursorHooksEnabled', true)
      setStagedDiffResolver(() => Promise.resolve(false))

      await stageDiff('src/app.ts', '', 'export const x = 1\n', 'typescript')
      assert.equal(await waitForFile(stdinFile), true)
      const stdin = expectRecord(parseJsonUnknown(readFileSync(stdinFile, 'utf-8')))
      assert.equal(stdin['applied'], false)
    })

    ownedIt(
      'afterDiffApply fires with applied:true on an approve (headless resolver)',
      async () => {
        const stdinFile = join(tempHome, 'approved.json')
        const script = await writeCaptureHook('after-approve.sh', stdinFile)
        await writeUserCopseHooks({ hooks: { afterDiffApply: [{ command: script }] } })
        await setSetting('cursorHooksEnabled', true)
        setStagedDiffResolver(() => Promise.resolve(true))

        await stageDiff('src/ok.ts', '', 'export const y = 2\n', 'typescript')
        assert.equal(await waitForFile(stdinFile), true)
        const stdin = expectRecord(parseJsonUnknown(readFileSync(stdinFile, 'utf-8')))
        assert.equal(stdin['applied'], true)
      },
    )
  })
})
