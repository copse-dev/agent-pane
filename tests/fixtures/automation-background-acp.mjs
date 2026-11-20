#!/usr/bin/env node
// Independent ACP child: after a returned prompt, its background helper reports
// new work and owns the checkout until the fixture's release file arrives.
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { clearInterval, setInterval } from 'node:timers'

function readableFrom(source) {
  return new ReadableStream({
    start(controller) {
      source.on('data', (chunk) => controller.enqueue(chunk))
      source.once('end', () => controller.close())
      source.once('error', (error) => controller.error(error))
    },
    cancel() {
      source.destroy()
    },
  })
}

const sessions = new Map()
let nextSession = 0
agent({ name: 'automation-background-fixture' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/new', (ctx) => {
    const sessionId = `background-session-${String(++nextSession)}`
    sessions.set(sessionId, ctx.params.cwd)
    return { sessionId }
  })
  .onRequest('session/prompt', async (ctx) => {
    const { sessionId } = ctx.params
    const cwd = sessions.get(sessionId)
    if (!cwd) throw new Error('Missing fixture checkout')
    const directory = join(cwd, '.copse-fixture')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'pid'), String(process.pid))
    writeFileSync(
      join(directory, 'checkpoint.txt'),
      'Background verification still owns this checkpoint.\n',
    )
    const update = (value) =>
      ctx.client.notify(methods.client.session.update, { sessionId, update: value })
    await update({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'The first check is complete. Background verification will report back shortly.',
      },
    })
    let started = false
    const timer = setInterval(() => {
      if (!started) {
        if (!existsSync(join(directory, 'begin-background'))) return
        started = true
        void (async () => {
          await update({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Background verification is running. Its checkpoint stays here until it finishes.',
            },
          })
          await update({
            sessionUpdate: 'tool_call',
            toolCallId: 'background-verification',
            title: 'Background verification',
            kind: 'other',
            status: 'in_progress',
            rawInput: { purpose: 'Preserve the checkout until verification finishes' },
          })
          writeFileSync(join(directory, 'started'), 'Background work reported after the prompt.\n')
        })().catch((error) => {
          process.stderr.write(String(error) + '\n')
        })
        return
      }
      if (!existsSync(join(directory, 'release'))) return
      clearInterval(timer)
      void (async () => {
        await update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'background-verification',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Background verification finished.' },
            },
          ],
        })
        await update({
          sessionUpdate: 'usage_update',
          used: 1,
          size: 2,
          _meta: { '_claude/origin': { kind: 'task-notification' } },
        })
        writeFileSync(
          join(directory, 'completed'),
          'The pending tool and self-started turn are terminal.\n',
        )
      })().catch((error) => {
        process.stderr.write(String(error) + '\n')
      })
    }, 25)
    return { stopReason: 'end_turn' }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), readableFrom(process.stdin)))
