import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'
import type { StreamChunk } from '@shared/types'
import { nodeReadableStream } from './node-readable-stream.ts'
import { sessionUpdateToStreamChunk } from './session-update-adapter.ts'

/**
 * Conformance against a **real external ACP agent**, in both protocol versions.
 *
 * `acp-loopback.test.ts` proves Copse's two halves agree with each other, which
 * cannot catch a shared misreading of the protocol. The agent here is a third
 * party: `@agentclientprotocol/sdk` publishes a runnable dual-version example
 * that answers v1 or v2 per connection (`agentProtocolRouter().withV1().withV2()`).
 * It costs nothing to run — no model, no API key, no network — and it version-
 * locks with the SDK we pin, so it moves when the protocol we build against moves.
 *
 * Two arms, doing different jobs:
 *
 *  - **v1** is a regression guard on the path Copse actually ships: the SDK
 *    client plus `session-update-adapter.ts`, driven over real ndjson framing
 *    against a separate process.
 *  - **v2** is an executable spec. Copse speaks v1 by design
 *    (docs/acp-v2-readiness.md), so this arm asserts nothing about Copse — it
 *    pins the wire shapes the migration has to handle, read off a working v2
 *    agent rather than off the RFDs. When `session-update-adapter.ts` learns v2,
 *    these are the updates it must map.
 */

// The runner compiles to `dist-test/` and runs node from the repo root, so
// `import.meta.dirname` is undefined under CJS — resolve from the runner's cwd,
// as acp-probe-worker.test.ts does. A deep file path rather than a package
// specifier on purpose: the SDK's `exports` map does not expose `./dist/*`.
const EXAMPLE_AGENT = join(
  process.cwd(),
  'node_modules/@agentclientprotocol/sdk/dist/examples/dual-version-agent.js',
)

function spawnExampleAgent(): ChildProcessWithoutNullStreams {
  assert.ok(
    existsSync(EXAMPLE_AGENT),
    `the SDK's dual-version example agent is missing at ${EXAMPLE_AGENT} — it ships in the ` +
      `@agentclientprotocol/sdk tarball, so this means the dependency layout changed`,
  )
  // ELECTRON_RUN_AS_NODE keeps the child a plain Node process when the suite is
  // run under Electron's binary, matching acp-probe-worker.test.ts.
  return spawn(process.execPath, [EXAMPLE_AGENT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** The same framing the product uses to talk to a spawned agent (acp-client.ts). */
function streamFor(child: ChildProcessWithoutNullStreams): ReturnType<typeof ndJsonStream> {
  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
  return ndJsonStream(writable, nodeReadableStream(child.stdout))
}

describe('external ACP agent conformance (v1)', () => {
  it('negotiates v1 and translates a real agent turn through the shipped adapter', async () => {
    const child = spawnExampleAgent()
    try {
      const chunks: StreamChunk[] = []
      const negotiated = { protocolVersion: 0 }

      const result = await client({ name: 'copse-conformance' }).connectWith(
        streamFor(child),
        async (ctx) => {
          const initialized = await ctx.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          })
          negotiated.protocolVersion = initialized.protocolVersion

          return ctx.buildSession('/tmp/project').withSession(async (session) => {
            session.prompt('hello')
            for (;;) {
              const message = await session.nextUpdate()
              if (message.kind === 'stop') return message.response
              const chunk = sessionUpdateToStreamChunk(message.update)
              if (chunk) chunks.push(chunk)
            }
          })
        },
      )

      // A v1 client gets v1 back even from an agent that also speaks v2 —
      // negotiation is per connection, which is what lets the migration be
      // gradual (docs/acp-v2-readiness.md).
      assert.equal(negotiated.protocolVersion, PROTOCOL_VERSION)
      assert.equal(result.stopReason, 'end_turn')
      assert.deepEqual(chunks, [{ type: 'text', text: 'Hello from the v1 implementation.' }])
    } finally {
      child.kill()
    }
  })
})

describe('external ACP agent conformance (v2 — the incoming surface)', () => {
  it('answers v2 with the regrouped initialize shape', async () => {
    const child = spawnExampleAgent()
    try {
      const initialized = await v2.client({ name: 'copse-conformance' }).connectWith(
        streamFor(child),
        async (ctx) =>
          await ctx.request(v2.methods.agent.initialize, {
            // `info` is REQUIRED in v2 and has no v1 counterpart: omit it and the
            // agent answers `-32602 invalid initialize params`. This is the
            // capability rename/regroup row of the readiness doc's table, and the
            // first thing acp-client.ts's `initialize` call has to grow.
            info: { name: 'copse-conformance', version: '0.0.0' },
            protocolVersion: v2.PROTOCOL_VERSION,
            capabilities: {},
          }),
      )

      assert.equal(initialized.protocolVersion, 2)
      assert.notEqual(v2.PROTOCOL_VERSION, PROTOCOL_VERSION)
      // v2 replaces `agentCapabilities` with a single `capabilities` plus `info`.
      assert.equal(initialized.info.name, 'dual-version-example')
      assert.ok(initialized.capabilities, 'v2 initialize must carry a `capabilities` object')
    } finally {
      child.kill()
    }
  })

  it('ends a turn with `state_update`, not with the prompt response', async () => {
    const child = spawnExampleAgent()
    try {
      const updates: v2.SessionUpdate[] = []

      const stopReason = await v2
        .client({ name: 'copse-conformance' })
        .connectWith(streamFor(child), async (ctx) => {
          await ctx.request(v2.methods.agent.initialize, {
            info: { name: 'copse-conformance', version: '0.0.0' },
            protocolVersion: v2.PROTOCOL_VERSION,
            capabilities: {},
          })
          return ctx.buildSession('/tmp/project').withSession(async (session) => {
            // `prompt()` resolves on ACCEPT in v2, so it is deliberately not
            // awaited for the turn: the turn ends when the agent says so.
            session.prompt('hello')
            for (;;) {
              const message = await session.nextUpdate()
              updates.push(message.update)
              // The SDK derives `stop` from the idle `state_update` — proof that
              // turn completion now travels as a session update.
              if (message.kind === 'stop') return message.stopReason
            }
          })
        })

      const kinds = updates.map((update) => update.sessionUpdate)

      // The v1 turn shape — `agent_message_chunk` deltas terminated by the
      // `session/prompt` response's stopReason — is gone. v2 carries the turn's
      // lifecycle in `state_update`, so the *prompt response* no longer means
      // "turn over" and `acp-turn-usage.ts` / the turn plumbing must read it here.
      // flatMap rather than filter: the conditional narrows the union inside the
      // branch, so `states` keeps the state_update member's own fields.
      const states = updates.flatMap((update) =>
        update.sessionUpdate === 'state_update' ? [update] : [],
      )
      assert.deepEqual(
        states.map((update) => update.state),
        ['running', 'idle'],
      )
      const [, idle] = states
      assert.equal(idle?.state === 'idle' ? idle.stopReason : undefined, 'end_turn')
      assert.equal(stopReason, 'end_turn')

      // Whole messages keyed by `messageId` replace the v1 chunk stream, for the
      // user's own prompt as well as the agent's reply — an upsert model the
      // adapter does not have today.
      assert.ok(
        kinds.includes('user_message'),
        `expected a user_message update, got ${String(kinds)}`,
      )
      const agentMessage = updates.find((update) => update.sessionUpdate === 'agent_message')
      assert.ok(agentMessage, `expected an agent_message update, got ${String(kinds)}`)
      assert.ok(
        'messageId' in agentMessage && typeof agentMessage.messageId === 'string',
        'v2 whole-message updates are keyed by messageId',
      )
    } finally {
      child.kill()
    }
  })
})
