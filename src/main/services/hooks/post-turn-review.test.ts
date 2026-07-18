// Contract tests for the `postTurnReview` fire path (F2, Copse-native).
//
// Pins the observation seam: after a post-turn review verdict, the canonical
// `postTurnReview` event carries `issues_found` + `summary` on stdin, dispatched
// **detached** (decision 3, never awaited), and Copse-only. House style mirrors
// `stop.test.ts` (a real spawned Copse script through the registry seam).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import {
  userCopseHooksConfigPath,
  resetCopseHookSessionErrorsForTest,
  setCopseHookTimeoutForTest,
} from './copse-adapter.ts'
import { runPostTurnReviewHooks } from './post-turn-review.ts'

let threadCounter = 0

function fire(payload: {
  issuesFound: boolean
  summary: string
}): ReturnType<typeof runPostTurnReviewHooks> {
  const threadId = `review-test-${String(threadCounter++)}`
  return runPostTurnReviewHooks(payload, {
    threadId,
    turnTreeId: asTurnTreeId(`${threadId}:turn`),
    workspaceRoot: null,
    projectTrusted: false,
  })
}

describe('postTurnReview (F2, Copse-native observation)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-post-review-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCopseHookSessionErrorsForTest()
    setCopseHookTimeoutForTest(2_000)
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCopseHookTimeoutForTest()
    await rm(tempHome, { recursive: true, force: true })
  })

  async function writeUserCopseHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.copse'), { recursive: true })
    await writeFile(userCopseHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  async function writeCaptureHook(name: string, stdinFile: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > '${stdinFile}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  it('does nothing when no postTurnReview hooks are registered', async () => {
    const result = await fire({ issuesFound: false, summary: '' })
    assert.equal(result.ran, 0)
    await result.settled
  })

  it('fires with the verdict on stdin', async () => {
    const stdinFile = join(tempHome, 'review.json')
    const script = await writeCaptureHook('review.sh', stdinFile)
    await writeUserCopseHooks({ hooks: { postTurnReview: [{ command: script }] } })

    const result = await fire({ issuesFound: true, summary: 'found a leak' })
    assert.equal(result.ran, 1)
    await result.settled
    assert.equal(existsSync(stdinFile), true)
    const stdin = JSON.parse(readFileSync(stdinFile, 'utf-8')) as {
      issues_found?: boolean
      summary?: string
    }
    assert.equal(stdin.issues_found, true)
    assert.equal(stdin.summary, 'found a leak')
  })

  it('is observation-only — a crashing hook never throws or blocks', async () => {
    const path = join(tempHome, 'crash.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserCopseHooks({
      hooks: { postTurnReview: [{ command: path, onFailure: 'closed' }] },
    })

    const result = await fire({ issuesFound: false, summary: '' })
    assert.equal(result.ran, 1)
    await result.settled
  })
})
