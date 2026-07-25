import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { setApprovalHandler } from '../approval.ts'
import { buildAcpAgentApp, type AcpTurnRunner } from './acp-agent-server.ts'
import {
  mergeAcpPermissionAbortSignals,
  permissionResponseFor,
  respondToPermissionForTest,
} from './acp-agent-service.ts'
import { runAcpSessionPrompt, type AcpClientHandlers } from './acp-client.ts'
import { acquireAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'

/**
 * PR1: permission RPC cancellation — honour turn abort and ACP `$/cancel_request`
 * while `session/request_permission` is blocked in the approval dialog.
 */

const CONFIG = { command: 'unused-in-tests', cwd: '/tmp/permission-cancel-test' }

const ALLOW_ONCE = { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const }
const REJECT_ONCE = { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const }

function permissionReq(): RequestPermissionRequest {
  return {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', title: 'run_shell', kind: 'other' },
    options: [ALLOW_ONCE, REJECT_ONCE],
  }
}

function runnerTransport(runner: AcpTurnRunner): () => Promise<{
  stream: ReturnType<typeof ndJsonStream>
  dispose: () => void
}> {
  return () => {
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const agentConnection = buildAcpAgentApp(runner, { name: 'permission-cancel-agent' }).connect(
      ndJsonStream(a2c.writable, c2a.readable),
    )
    return Promise.resolve({
      stream: ndJsonStream(c2a.writable, a2c.readable),
      dispose: () => {
        agentConnection.close()
      },
    })
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve()
      },
      { once: true },
    )
  })
}

describe('ACP permission cancel (PR1)', () => {
  afterEach(async () => {
    setApprovalHandler(null)
    await disposeAllAcpSessions()
  })

  it('respondToPermission returns cancelled when the merged signal aborts during approval', async () => {
    setApprovalHandler(async (_req, signal) => {
      assert.ok(signal)
      await waitForAbort(signal)
      return { approved: false, remember: false }
    })
    const turn = new AbortController()
    const rpc = new AbortController()
    const merged = mergeAcpPermissionAbortSignals(turn.signal, rpc.signal)
    const pending = respondToPermissionForTest(
      { id: 'agent', title: 'Test Agent', sandboxed: false },
      permissionReq(),
      null,
      null,
      merged,
    )
    await Promise.resolve()
    turn.abort()
    const outcome = await pending
    assert.deepEqual(outcome.outcome, { outcome: 'cancelled' })
  })

  it('turn Stop unblocks a blocked permission RPC with cancelled', async () => {
    let releaseApproval!: () => void
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    setApprovalHandler(async () => {
      await approvalGate
      return { approved: true, remember: false }
    })

    const runner: AcpTurnRunner = async (ctx) => {
      const decision = await ctx.requestPermission({
        toolCallId: 't1',
        title: 'run_shell',
        rawInput: {},
      })
      return { stopReason: decision === 'allow' ? 'end_turn' : 'cancelled' }
    }

    const { entry } = await acquireAcpSession({
      threadId: 'perm-cancel',
      config: CONFIG,
      createTransport: runnerTransport(runner),
    })
    const controller = new AbortController()
    const handlers: AcpClientHandlers = {
      onChunk: () => {},
      requestPermission: (req, rpcSignal) =>
        respondToPermissionForTest(
          { id: 'agent', title: 'Test Agent', sandboxed: false },
          req,
          null,
          null,
          mergeAcpPermissionAbortSignals(controller.signal, rpcSignal),
        ),
    }
    entry.open.handlers.current = handlers

    const prompt = runAcpSessionPrompt(entry.open, 'go', undefined, controller.signal, 50)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    const result = await prompt

    assert.equal(result.stopReason, 'cancelled')
    assert.equal(entry.open.isClosed(), false)
    releaseApproval()
  })

  it('maps a settled deny after abort to cancelled, not reject_once', async () => {
    const signal = AbortSignal.abort()
    const outcome = await respondToPermissionForTest(
      { id: 'agent', title: 'Test Agent', sandboxed: false },
      permissionReq(),
      null,
      null,
      signal,
    )
    assert.deepEqual(outcome.outcome, { outcome: 'cancelled' })
    assert.notDeepEqual(outcome, permissionResponseFor([ALLOW_ONCE, REJECT_ONCE], false))
  })
})
