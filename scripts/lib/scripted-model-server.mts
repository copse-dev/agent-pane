/**
 * A deterministic OpenAI-compatible chat-completions server for exercising the
 * container worker end to end without a real model. Each request consumes the
 * next scripted turn: either a `run_shell` tool call or a final text answer.
 * Streams the SSE shape the product's OpenAI-compatible provider parses, so the
 * whole loop — provider client, egress broker, tool dispatch, permission gate,
 * deferral queue — runs for real; only the model's judgement is scripted.
 */
import { createServer, type Server } from 'node:http'

export type ScriptedTurn =
  | { kind: 'shell'; command: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'text'; text: string }

export interface ScriptedModelServer {
  readonly port: number
  readonly requests: number
  stop(): Promise<void>
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function chunk(delta: Record<string, unknown>, finish: string | null): unknown {
  return {
    id: 'scripted',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

export function startScriptedModelServer(
  turns: readonly ScriptedTurn[],
): Promise<ScriptedModelServer> {
  let index = 0
  let requests = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (part: Buffer) => {
      body += part.toString()
    })
    req.on('end', () => {
      requests += 1
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const turn = turns[index] ?? { kind: 'text' as const, text: 'Done.' }
      index += 1
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(sse(chunk({ role: 'assistant', content: '' }, null)))
      if (turn.kind === 'text') {
        res.write(sse(chunk({ content: turn.text }, null)))
        res.write(sse(chunk({}, 'stop')))
      } else {
        const name = turn.kind === 'shell' ? 'run_shell' : turn.name
        const args = turn.kind === 'shell' ? { command: turn.command } : turn.args
        res.write(
          sse(
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${String(index)}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              null,
            ),
          ),
        )
        res.write(sse(chunk({}, 'tool_calls')))
      }
      res.write('data: [DONE]\n\n')
      res.end()
      void body
    })
  })
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('scripted model server did not bind a TCP port')
      }
      const { port } = address
      resolveStart({
        get port() {
          return port
        },
        get requests() {
          return requests
        },
        stop: () =>
          new Promise<void>((resolveStop) => {
            server.close(() => {
              resolveStop()
            })
          }),
      })
    })
  })
}
