import { Readable, Writable } from 'node:stream'
import * as v1 from '@agentclientprotocol/sdk'
import * as v2 from '@agentclientprotocol/sdk/experimental/v2'

let nextSession = 0
let nextMessage = 0

const v1Agent = v1
  .agent({ name: 'copse-v1-conformance-fixture' })
  .onRequest(v1.methods.agent.initialize, ({ params }) => ({
    protocolVersion: Math.min(params.protocolVersion, v1.PROTOCOL_VERSION),
    agentCapabilities: {},
  }))
  .onRequest(v1.methods.agent.session.new, () => ({ sessionId: `v1-session-${++nextSession}` }))
  .onRequest(v1.methods.agent.session.prompt, async ({ params, client }) => {
    await client.notify(v1.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from the v1 implementation.' },
      },
    })
    return { stopReason: 'end_turn' }
  })

const v2Agent = v2
  .agent({ name: 'copse-v2-conformance-fixture' })
  .onRequest(v2.methods.agent.initialize, ({ params }) => ({
    protocolVersion: Math.min(params.protocolVersion, v2.PROTOCOL_VERSION),
    info: { name: 'dual-version-example', version: '2.2.0' },
    capabilities: {},
  }))
  .onRequest(v2.methods.agent.session.new, () => ({ sessionId: `v2-session-${++nextSession}` }))
  .onRequest(v2.methods.agent.session.prompt, ({ params, client }) => {
    const messageId = `user-${++nextMessage}`
    setTimeout(() => {
      void (async () => {
        await client.notify(v2.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'user_message',
            messageId,
            content: params.prompt,
          },
        })
        await client.notify(v2.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'state_update', state: 'running' },
        })
        await client.notify(v2.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message',
            messageId: `agent-${nextMessage}`,
            content: [{ type: 'text', text: 'Hello from the v2 implementation.' }],
          },
        })
        await client.notify(v2.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
        })
      })()
    }, 0)
    return { messageId }
  })

const stream = v1.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
const connection = v2.agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(stream)
await connection.closed
