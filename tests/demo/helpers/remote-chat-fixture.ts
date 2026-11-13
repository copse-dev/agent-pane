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
  let shared = true
  let archived = false
  let pendingApproval = false
  let submissions = 0
  // Every desktop publish bumps the revision; the browser reuses an unchanged one.
  let shareChanges = 0
  function reply(response: ServerResponse, value: unknown, status = 200): void {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
  }
  return (pathname, request, response): boolean => {
    if (pathname === '/remote-fixture/reset') {
      offline = false
      shared = true
      archived = false
      pendingApproval = false
      submissions = 0
      shareChanges = 0
      reply(response, {})
      return true
    }
    // The desktop stops publishing the thread, as after a new desktop session
    // whose project is not open yet; its saved metadata is still readable.
    if (pathname === '/remote-fixture/unshare' || pathname === '/remote-fixture/share') {
      shared = pathname.endsWith('/share')
      shareChanges += 1
      reply(response, {})
      return true
    }
    // The desktop run asks the phone for an approval.
    if (pathname === '/remote-fixture/approval') {
      pendingApproval = true
      reply(response, {})
      return true
    }
    // Archiving or deleting the thread also makes its metadata route 404.
    if (pathname === '/remote-fixture/archive' || pathname === '/remote-fixture/restore') {
      archived = pathname.endsWith('/archive')
      shared = !archived
      shareChanges += 1
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
          revision: 1 + submissions + shareChanges,
          views: [
            {
              projectId: 'proj-1',
              threads: !shared
                ? []
                : [
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
      if (archived) reply(response, { error: 'Thread unavailable' }, 404)
      else
        reply(response, {
          access: 'control',
          sessionId,
          runId: null,
          decisions: pendingApproval
            ? [
                {
                  id: '22222222-2222-4222-8222-222222222222',
                  kind: 'approval',
                  title: 'Run outside sandbox?',
                  body: 'pnpm run check',
                },
              ]
            : [],
        })
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
