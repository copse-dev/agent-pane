#!/usr/bin/env node
/**
 * A scripted ACP agent, spawned as a real child process by
 * `src/main/services/acp/acp-spawn.test.ts`.
 *
 * Every other ACP test fakes the agent *in process* — either Copse's own agent
 * role (`acp-agent-server.ts`) or a bare `agent()` app — wired to the client
 * through two `TransformStream`s. That leaves one layer with no coverage at all:
 * the process boundary itself. `spawnAcpAgentProcess`, the stdout→ndjson reader,
 * the stderr tail, and the exit-error surfacing only run when there is a real
 * child, and in CI there is no ACP agent installed to be one.
 *
 * This is that child. Two properties are deliberate:
 *
 * - **No model, no key.** It answers from a fixed script, so it runs anywhere
 *   `node` does — no auth, no tokens, no network.
 * - **Not Copse's agent role.** It is an independent implementation over the
 *   bare SDK, so the client is also exercised against an agent that shares none
 *   of its assumptions. A loopback against our own server can only agree with
 *   itself.
 *
 * The prompt text steers it:
 *
 * | prompt contains | behaviour                                                  |
 * | --------------- | ---------------------------------------------------------- |
 * | `ask`           | request permission, then report the client's answer         |
 * | `crash`         | write to stderr and exit non-zero **mid-turn**              |
 * | anything else   | echo it back as an agent message chunk                      |
 */
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Writable } from 'node:stream'

/** Bridge Node's stdin to the SDK's Web Stream type (mirrors node-readable-stream.ts). */
function readableFrom(source) {
  return new ReadableStream({
    start(controller) {
      source.on('data', (chunk) => {
        controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk)))
      })
      source.once('end', () => {
        controller.close()
      })
      source.once('error', (error) => {
        controller.error(error)
      })
    },
    cancel() {
      source.destroy()
    },
  })
}

function promptText(blocks) {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

let nextSessionId = 0

agent({ name: 'mock-acp-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/new', () => {
    nextSessionId += 1
    return { sessionId: `mock-session-${String(nextSessionId)}` }
  })
  .onRequest('session/prompt', async (ctx) => {
    const { sessionId, prompt } = ctx.params
    const text = promptText(prompt)
    const say = (chunk) =>
      ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
      })

    if (text.includes('crash')) {
      await say('about to fall over')
      // The client should surface this line with the exit, which is the whole
      // point of capturing the child's stderr rather than discarding it.
      process.stderr.write('mock-acp-agent: exploding on request\n')
      process.exit(3)
    }

    if (text.includes('ask')) {
      const response = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: 'mock-tool-1',
          title: 'Delete everything',
          status: 'pending',
          rawInput: { path: '/' },
        },
        options: [
          { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        ],
      })
      const outcome = response.outcome
      const decision =
        outcome.outcome === 'cancelled' ? 'cancelled' : `answered ${String(outcome.optionId)}`
      await say(`client ${decision}`)
      return { stopReason: 'end_turn' }
    }

    await say(`echo:${text}`)
    return { stopReason: 'end_turn' }
  })
  .onNotification('session/cancel', () => {})
  .connect(ndJsonStream(Writable.toWeb(process.stdout), readableFrom(process.stdin)))
