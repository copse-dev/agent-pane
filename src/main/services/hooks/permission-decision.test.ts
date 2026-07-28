// Contract tests for the `permissionDecision` fire path (F2, Copse-native).
//
// Pins the observation seam #840's audit trail will subscribe to: after a
// verdict, the canonical `permissionDecision` event carries the gated tool name
// + the canonical decision on stdin, dispatched **detached** (decision 3, never
// awaited), matcher-scoped on the tool name, and Copse-only. House style mirrors
// `stop.test.ts` (a real spawned Copse script through the registry seam).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expectRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import {
  userCopseHooksConfigPath,
  resetCopseHookSessionErrorsForTest,
  setCopseHookTimeoutForTest,
} from './copse-adapter.ts'
import { runPermissionDecisionHooks } from './permission-decision.ts'

let threadCounter = 0

function fire(
  toolName: string,
  decision: 'allow' | 'deny' | 'ask',
): ReturnType<typeof runPermissionDecisionHooks> {
  const threadId = `perm-test-${String(threadCounter++)}`
  return runPermissionDecisionHooks(toolName, decision, {
    threadId,
    turnTreeId: asTurnTreeId(`${threadId}:turn`),
    workspaceRoot: null,
    projectTrusted: false,
  })
}

describe('permissionDecision (F2, Copse-native observation)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-perm-decision-'))
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

  it('does nothing when no permissionDecision hooks are registered', async () => {
    const result = await fire('run_shell', 'allow')
    assert.equal(result.ran, 0)
    await result.settled
  })

  it('fires with the tool name + decision on stdin', async () => {
    const stdinFile = join(tempHome, 'verdict.json')
    const script = await writeCaptureHook('audit.sh', stdinFile)
    await writeUserCopseHooks({ hooks: { permissionDecision: [{ command: script }] } })

    const result = await fire('run_shell', 'ask')
    assert.equal(result.ran, 1)
    // Detached: await completion (a test affordance) before inspecting stdin.
    await result.settled
    assert.equal(existsSync(stdinFile), true)
    const stdin = expectRecord(parseJsonUnknown(readFileSync(stdinFile, 'utf-8')))
    assert.equal(stdin['tool_name'], 'run_shell')
    assert.equal(stdin['decision'], 'ask')
  })

  it('honours a matcher on the tool name', async () => {
    const script = await writeCaptureHook('match.sh', join(tempHome, 'unused.json'))
    await writeUserCopseHooks({
      hooks: { permissionDecision: [{ command: script, matcher: '^run_shell$' }] },
    })

    const matched = await fire('run_shell', 'deny')
    assert.equal(matched.ran, 1)
    await matched.settled

    const unmatched = await fire('fetch_url', 'deny')
    assert.equal(unmatched.ran, 0)
    await unmatched.settled
  })

  it('is observation-only — a crashing hook never throws or blocks', async () => {
    const path = join(tempHome, 'crash.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserCopseHooks({
      hooks: { permissionDecision: [{ command: path, onFailure: 'closed' }] },
    })

    // Even a failClosed hook cannot change a verdict that already happened: the
    // fire path ignores any decision and just reports the hook ran.
    const result = await fire('run_shell', 'allow')
    assert.equal(result.ran, 1)
    await result.settled
  })
})
