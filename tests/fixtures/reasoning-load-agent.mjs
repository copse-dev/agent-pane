// Independent ACP producer: its clock keeps advancing if the renderer stalls.
// Exercise the normal provider boundary without adding a product test hook.
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

const output = process.argv[2]
let cancelled = false

agent({ name: 'reasoning-load-fixture' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/new', () => ({ sessionId: 'reasoning-load-session' }))
  .onRequest('session/prompt', async (ctx) => {
    cancelled = false
    const update = (value) =>
      ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: value,
      })
    const reason = (text) =>
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })

    for (let step = 0; step < 12; step++) {
      await reason(
        `Completed step ${String(step)}.\n\n${'Checked the fixture carefully. '.repeat(140)}`,
      )
      await update({
        sessionUpdate: 'tool_call',
        toolCallId: `read-${String(step)}`,
        title: 'Read fixture',
        kind: 'read',
        status: 'completed',
        rawInput: { path: `fixture-${String(step)}.md` },
        content: [{ type: 'content', content: { type: 'text', text: 'Fixture checked.' } }],
      })
    }
    await reason('Live reasoning begins.\n\n')
    // Let WebDriver install the observer before the fixed-rate phase begins.
    await delay(1_500)
    const chunk = 'Checking **the next detail** and preserving earlier conclusions.\n\n'.repeat(8)
    const count = 240
    const intervalMs = 20
    const started = performance.now()
    const latenessMs = []
    let sent = 0
    for (; sent < count && !cancelled; sent++) {
      const scheduled = started + sent * intervalMs
      await delay(Math.max(0, scheduled - performance.now()))
      latenessMs.push(Math.max(0, performance.now() - scheduled))
      await reason(chunk)
    }
    if (output) {
      await writeFile(
        output,
        JSON.stringify({
          sent,
          count,
          intervalMs,
          chunk,
          startedAt: performance.timeOrigin + started,
          elapsedMs: performance.now() - started,
          latenessMs,
        }),
      )
    }
    if (!cancelled) {
      await update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Reasoning workload complete.' },
      })
    }
    return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
  })
  .onNotification('session/cancel', () => {
    cancelled = true
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
