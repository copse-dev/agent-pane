import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { runWithWorkspaceRoot } from '../workspace.ts'
import { DeferredApprovalError } from '@shared/threads/deferred-approval.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { beginDeferralMode, endDeferralMode } from '../security/deferral-mode.ts'
import { readPendingDeferrals } from '../security/deferred-approval-store.ts'
import { runWithApprovalHandler } from '../approval.ts'
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import type { GeneratedImage, ImageGenerationRequest } from '../../tools/image-gen-tool.ts'
import type { AcpTransportFactory } from './acp-client.ts'
import { runAcpImageSession, runAcpImageGeneration } from './acp-image-generation.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
const config = { command: 'unused', cwd: '/tmp/project' }
const runner = { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: true }

function transport(
  data: string | null,
  cancelled = false,
  onPrompt?: (prompt: string) => Promise<void>,
  permission = false,
  report = '',
  refused = false,
): AcpTransportFactory {
  const app = agent({ name: 'image-test' })
    .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest('session/new', (ctx) => {
      assert.deepEqual(ctx.params.mcpServers, [], 'no image_gen bridge recursion')
      return { sessionId: 'image-session' }
    })
    .onRequest('session/prompt', async (ctx) => {
      const prompt = ctx.params.prompt
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n')
      await onPrompt?.(prompt)
      if (report)
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: report } },
        })
      if (permission)
        await ctx.client.request(methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: 'image-tool', title: 'Generate image', kind: 'other' },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        })
      if (data !== null)
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', mimeType: 'image/png', data },
          },
        })
      return { stopReason: refused ? 'refusal' : cancelled ? 'cancelled' : 'end_turn' }
    })
  const c2a = new TransformStream<Uint8Array, Uint8Array>()
  const a2c = new TransformStream<Uint8Array, Uint8Array>()
  app.connect(ndJsonStream(a2c.writable, c2a.readable))
  return () =>
    Promise.resolve({ stream: ndJsonStream(c2a.writable, a2c.readable), dispose: () => {} })
}

describe('ACP image session', () => {
  it('collects a PNG through a real ACP session without exposing host tools', async () => {
    const result = await runAcpImageSession(
      config,
      runner,
      'A cat',
      new AbortController().signal,
      transport(PNG),
    )
    assert.deepEqual(result, { image: { base64: PNG }, report: '' })
  })

  it('requires an actual image rather than trusting a success report', async () => {
    assert.deepEqual(
      await runAcpImageSession(
        config,
        runner,
        'A cat',
        new AbortController().signal,
        transport(null),
      ),
      { image: null, report: '' },
    )
  })

  it('stops on an explicit provider refusal', async () => {
    await assert.rejects(
      () =>
        runAcpImageSession(
          config,
          runner,
          'A cat',
          new AbortController().signal,
          transport(null, false, undefined, false, '', true),
        ),
      /refused this request/,
    )
  })

  it('rejects invalid bitmap data', async () => {
    await assert.rejects(
      () =>
        runAcpImageSession(
          config,
          runner,
          'A cat',
          new AbortController().signal,
          transport('bm90IGEgcG5n'),
        ),
      /PNG/,
    )
  })

  it('does not treat a cancelled session as success even if an image arrived', async () => {
    await assert.rejects(
      () =>
        runAcpImageSession(
          config,
          runner,
          'A cat',
          new AbortController().signal,
          transport(PNG, true),
        ),
      /cancelled/,
    )
  })
})

describe('ACP image artifacts', () => {
  const request = {
    prompt: 'A cat',
    size: 'auto',
    quality: 'auto',
    background: 'auto',
  } satisfies ImageGenerationRequest

  for (const malicious of [false, true]) {
    it(
      malicious
        ? 'refuses a symlink artifact and cleans scratch'
        : 'reads only the exact PNG output and cleans scratch',
      async () => {
        const workspace = await realpath(await mkdtemp(join(tmpdir(), 'copse-image-test-')))
        try {
          const source = join(workspace, 'existing.png')
          await writeFile(source, Buffer.from(PNG, 'base64'))
          const injected = transport(null, false, async (prompt) => {
            const output = /Save the generated PNG to this exact path: (.+?)\. You may/.exec(
              prompt,
            )?.[1]
            assert.ok(output)
            if (malicious) await symlink(source, output)
            else await writeFile(output, Buffer.from(PNG, 'base64'))
          })
          const isolated: AcpTransportFactory = (spawn, signal) => {
            assert.ok(relative(workspace, spawn.cwd).startsWith(join('.tmp', 'image-gen-')))
            return injected(spawn, signal)
          }
          const generate = (): Promise<GeneratedImage> =>
            runWithWorkspaceRoot(workspace, () =>
              runAcpImageGeneration(runner, request, new AbortController().signal, isolated),
            )
          if (malicious) await assert.rejects(generate, /symlink/)
          else assert.deepEqual(await generate(), { base64: PNG })
          assert.deepEqual(await readdir(join(workspace, '.tmp')), [])
        } finally {
          await rm(workspace, { recursive: true, force: true })
        }
      },
    )
  }

  it('preserves the runner report when native generation is unavailable', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'copse-image-unavailable-')))
    try {
      await assert.rejects(
        () =>
          runWithWorkspaceRoot(workspace, () =>
            runAcpImageGeneration(
              runner,
              request,
              new AbortController().signal,
              transport(null, false, undefined, false, 'Native image generation is unavailable.'),
            ),
          ),
        /Native image generation is unavailable/,
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('propagates a real runner permission rejection even if the runner returns an image', async () => {
    let asked = 0
    await assert.rejects(
      () =>
        runWithApprovalHandler(
          async () => {
            asked++
            return { approved: false, remember: false }
          },
          () =>
            runAcpImageSession(
              config,
              runner,
              'A cat',
              new AbortController().signal,
              transport(PNG, false, undefined, true),
            ),
        ),
      /declined/,
    )
    assert.equal(asked, 1)
  })
})

it('preserves deferred approval across the ACP RPC boundary', async () => {
  const store = await mkdtemp(join(tmpdir(), 'copse-image-deferral-'))
  const previous = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = store
  const threadId = 'image-deferred-thread'
  beginDeferralMode(threadId)
  try {
    await assert.rejects(
      () =>
        runWithActiveRunIdentity(threadId, () =>
          runAcpImageSession(
            config,
            runner,
            'A cat',
            new AbortController().signal,
            transport(PNG, false, undefined, true),
          ),
        ),
      DeferredApprovalError,
    )
    const pending = await readPendingDeferrals({ projectId: null })
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.threadId, threadId)
  } finally {
    endDeferralMode(threadId)
    if (previous === undefined) Reflect.deleteProperty(process.env, 'COPSE_WORKSPACE_DIR')
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    await rm(store, { recursive: true, force: true })
  }
})
