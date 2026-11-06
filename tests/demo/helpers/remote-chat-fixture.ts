import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../../../packages/std/src/safe-json.ts'
import { remoteStateSchema } from '../../../src/shared/remote-interface.ts'

/** Network boundary for the shipped remote renderer; no product-only test switches. */
export function createRemoteChatFixture(): (
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
) => boolean {
  const sessionId = '11111111-1111-4111-8111-111111111111'
  let offline = false
  let submissions = 0
  function reply(response: ServerResponse, value: unknown, status = 200): void {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  return (pathname, request, response): boolean => {
    if (pathname === '/remote-fixture/reset') {
      offline = false
      submissions = 0
      reply(response, {})
      return true
    }
    if (pathname === '/remote-fixture/offline' || pathname === '/remote-fixture/online') {
      offline = pathname.endsWith('/offline')
      reply(response, {})
      return true
    }
    if (pathname === '/remote-fixture/status') {
      reply(response, { submissions })
      return true
    }
    if (request.headers.authorization !== 'Bearer shared-chat-test-token') return false
    if (!pathname.startsWith('/api/')) return false
    if (offline) {
      reply(response, { error: 'Disconnected' }, 503)
      return true
    }
    if (pathname === '/api/remote/state') {
      reply(
        response,
        remoteStateSchema.parse({
          version: 1,
          sessionId,
          revision: 1 + submissions,
          views: [
            {
              projectId: 'proj-1',
              threads: [
                {
                  id: 'thread-1',
                  title: 'Test the shared chat',
                  status: 'idle',
                  createdAt: 1,
                  updatedAt: 2,
                  usage: { inputTokens: 0, outputTokens: 0 },
                  messages: [
                    {
                      id: 'user-1',
                      role: 'user',
                      content: 'Prepare the mobile release.',
                      createdAt: 1,
                      toolCalls: [],
                    },
                    {
                      id: 'assistant-1',
                      role: 'assistant',
                      content: 'The **shared chat** is ready for a focused test.',
                      createdAt: 2,
                      toolCalls: [],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      )
      return true
    }
    if (pathname === '/api/thread/proj-1/thread-1') {
      reply(response, { access: 'control', sessionId, runId: null })
      return true
    }
    if (pathname === '/api/remote/read' || pathname === '/api/action') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = safeJsonParse(
          Buffer.concat(chunks).toString(),
          decodeWithSchema(
            z.object({ channel: z.string().optional(), action: z.string().optional() }),
          ),
        )
        if (!body) {
          reply(response, { error: 'Invalid fixture request' }, 400)
          return
        }
        if (pathname === '/api/action') {
          if (body.action === 'message') submissions += 1
          reply(response, { ok: true })
        } else {
          reply(response, {
            value: body.channel === 'settings:get' ? true : 'Run the phone reconnect test.',
          })
        }
      })
      return true
    }
    reply(response, { error: 'Unknown fixture endpoint' }, 404)
    return true
  }
}
