import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { setApprovalHandler } from '../approval.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { activateGuardedYoloForRun, armGuardedYolo, disableGuardedYolo } from './guarded-yolo.ts'
import { ensureShellCommandPermitted } from './permission-gate.ts'

describe('Guarded YOLO uncertain host power consent', () => {
  it('times out a flagged rm and returns a rewrite hint so the run can continue', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const threadId = 'guarded-yolo-rm-timeout'
    armGuardedYolo(threadId)
    activateGuardedYoloForRun(threadId)
    let announce: () => void = () => {}
    const shown = new Promise<void>((resolve) => {
      announce = resolve
    })
    let promptSignal: AbortSignal | undefined
    setApprovalHandler((request, signal) => {
      assert.equal(request.timeoutMs, 120_000)
      announce()
      promptSignal = signal
      return new Promise(() => {})
    })
    try {
      const pending = runWithActiveRunIdentity(threadId, () =>
        ensureShellCommandPermitted('rm -rf build', {
          executionRoot: '/work/project',
          sandboxEnabled: true,
        }),
      )
      const denied = assert.rejects(pending, /timed out after two minutes.*Rewrite the command/)
      await shown
      t.mock.timers.tick(120_000)
      await denied
      assert.equal(promptSignal?.aborted, true)
      assert.equal(
        await runWithActiveRunIdentity(threadId, () =>
          ensureShellCommandPermitted('echo continuing', {
            executionRoot: '/work/project',
            sandboxEnabled: true,
          }),
        ),
        true,
      )
    } finally {
      setApprovalHandler(null)
      disableGuardedYolo(threadId)
    }
  })

  it('asks for every invocation, honors rejection, and never offers a hard-deny override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guarded-yolo-consent-'))
    const threadId = 'guarded-yolo-consent'
    const command = 'node report.mts'
    writeFileSync(join(root, 'report.mts'), 'console.log("shutdown report")')
    armGuardedYolo(threadId)
    activateGuardedYoloForRun(threadId)
    let prompts = 0
    setApprovalHandler(async (request) => {
      prompts += 1
      assert.equal(request.title, 'Guarded YOLO safety check')
      assert.equal(request.body, command)
      assert.equal(request.cause, 'shell-guarded-yolo-harm')
      assert.equal(request.allowRemember, false)
      assert.equal(request.scope, 'external')
      assert.match(request.bodyAdvice ?? '', /could not be confirmed/)
      assert.match(request.bodyFooter ?? '', /outside the project sandbox/)
      return { approved: prompts === 1, remember: false }
    })
    try {
      await runWithActiveRunIdentity(threadId, async () => {
        const options = { executionRoot: root, sandboxEnabled: false }
        assert.equal(await ensureShellCommandPermitted(command, options), true)
        assert.equal(await ensureShellCommandPermitted(command, options), false)
        assert.equal(prompts, 2)
        await assert.rejects(
          ensureShellCommandPermitted('sudo shutdown -h now', options),
          /host shutdown or reboot is never allowed/,
        )
        assert.equal(prompts, 2)
      })
    } finally {
      setApprovalHandler(null)
      disableGuardedYolo(threadId)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('labels contained harm approvals as sandboxed', async () => {
    const threadId = 'guarded-yolo-contained-consent'
    armGuardedYolo(threadId)
    activateGuardedYoloForRun(threadId)
    let prompts = 0
    setApprovalHandler(async (request) => {
      prompts += 1
      assert.equal(request.allowRemember, false)
      assert.equal(request.scope, 'sandbox')
      assert.equal(request.bodyFooter, 'Runs inside the project sandbox.')
      return { approved: false, remember: false }
    })
    try {
      await runWithActiveRunIdentity(threadId, async () => {
        assert.equal(
          await ensureShellCommandPermitted('rm -rf build', {
            executionRoot: '/work/project',
            sandboxEnabled: true,
          }),
          false,
        )
      })
      assert.equal(prompts, 1)
    } finally {
      setApprovalHandler(null)
      disableGuardedYolo(threadId)
    }
  })
})
