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
 * | prompt contains  | behaviour                                                      |
 * | ---------------- | -------------------------------------------------------------- |
 * | `report-env:A,B` | reply `env:{"A":…,"B":…}`: those vars as this process got them |
 * | `echo-prompt`    | reply `prompt:` and the whole prompt text, Copse's notes included |
 * | `say:TEXT`       | reply TEXT (the rest of that line), and nothing else            |
 * | `list-mcp-tools` | list each offered http server's tools now, then reply `listed`  |
 * | `stop-mid-command` | start an `execute` call, reply while it runs, end on cancel |
 * | `ask-execute`    | request an `execute` permission with no command or title       |
 * | `run-kindless`   | request permission for `rm -rf build` with no tool `kind`      |
 * | `ask`            | request permission, then report the client's answer            |
 * | `crash`          | write to stderr and exit non-zero **mid-turn**                 |
 * | anything else    | echo it back as an agent message chunk                         |
 *
 * `report-env:`, `say:`, `list-mcp-tools` and `echo-prompt` are checked first: a
 * turn driven through Copse's own prompt builder carries a preamble whose words
 * (`task`, …) would otherwise trip the substring branches below.
 *
 * Flags steer how it treats the MCP servers Copse offers in `session/new`
 * (#4144):
 *
 * | flag                   | behaviour                                                    |
 * | ---------------------- | ------------------------------------------------------------ |
 * | `--mcp-http`           | advertise `mcpCapabilities.http`, so Copse offers its bridge  |
 * | `--list-mcp-tools`     | list each offered http server's tools before `session/new` returns |
 * | `--report-mcp-failure` | on the first prompt, report each offered server as failed the |
 * |                        | way Claude Agent ACP does for a client without notices        |
 *
 * `--mcp-http` alone is an agent that is offered the bridge and never mounts it,
 * until a `list-mcp-tools` prompt mounts it late.
 *
 * No permission request ever runs anything: the agent only reports the
 * client's answer.
 */
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
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

const flags = new Set(process.argv.slice(2))

/** One stateless MCP request over streamable HTTP, as an agent's MCP client sends it. */
async function mcpRequest(server, id, method) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  for (const header of server.headers ?? []) headers[header.name] = header.value
  const params =
    method === 'initialize'
      ? {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mock-acp-agent', version: '0' },
        }
      : {}
  const response = await globalThis.fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  await response.text()
}

/** Mount servers the way an agent's MCP client does: initialize, then list the tools. */
async function listTools(servers) {
  for (const server of servers) {
    await mcpRequest(server, 1, 'initialize')
    await mcpRequest(server, 2, 'tools/list')
  }
}

let nextSessionId = 0
/** The http MCP servers each session was offered, by session id. */
const offeredServers = new Map()
const reportedFailures = new Set()
/** Turns parked until the client cancels them (`stop-mid-command`). */
const awaitingCancel = new Set()

agent({ name: 'mock-acp-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      ...(flags.has('--mcp-http') ? { mcpCapabilities: { http: true } } : {}),
    },
  }))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/new', async (ctx) => {
    nextSessionId += 1
    const sessionId = `mock-session-${String(nextSessionId)}`
    const servers = (ctx.params.mcpServers ?? []).filter((server) => server.type === 'http')
    offeredServers.set(sessionId, servers)
    if (flags.has('--list-mcp-tools')) await listTools(servers)
    return { sessionId }
  })
  .onRequest('session/prompt', async (ctx) => {
    const { sessionId, prompt } = ctx.params
    const text = promptText(prompt)
    const say = (chunk) =>
      ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
      })

    // Claude Agent ACP's transcript fallback for a failed client MCP server
    // (reportMcpServerStartupFailures + noticeOrTranscriptUpdate, 0.100.0).
    if (flags.has('--report-mcp-failure') && !reportedFailures.has(sessionId)) {
      reportedFailures.add(sessionId)
      for (const server of offeredServers.get(sessionId) ?? []) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `**MCP server "${server.name}" failed to start:** Its tools are unavailable in this session. Run /mcp for the error.`,
            },
            _meta: {
              claudeCode: { kind: 'mcpServerStatus', server: server.name, status: 'failed' },
            },
          },
        })
      }
    }

    // A null value means the var was absent, distinct from an empty string.
    const reportEnv = /report-env:([A-Za-z0-9_,]+)/.exec(text)
    if (reportEnv) {
      const names = reportEnv[1].split(',').filter(Boolean)
      const received = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))
      await say(`env:${JSON.stringify(received)}`)
      return { stopReason: 'end_turn' }
    }

    const sayLine = /say:([^\n]*)/.exec(text)
    if (sayLine) {
      await say(sayLine[1].trim())
      return { stopReason: 'end_turn' }
    }

    if (text.includes('list-mcp-tools')) {
      await listTools(offeredServers.get(sessionId) ?? [])
      await say('listed')
      return { stopReason: 'end_turn' }
    }

    if (text.includes('echo-prompt')) {
      await say(`prompt:${text}`)
      return { stopReason: 'end_turn' }
    }

    // Checked before the substring branches for the same reason as
    // `report-env:`. The command never runs: the call stays in progress until
    // the client's Stop cancels the turn, so the reply below lands in a later
    // bubble than the call it interrupts.
    if (text.includes('stop-mid-command')) {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'mock-tool-long-check',
          title: 'Run the long check',
          kind: 'execute',
          status: 'in_progress',
          rawInput: { command: 'pnpm run check' },
        },
      })
      await say('The long check is running; it takes a few minutes.')
      await new Promise((resolve) => {
        awaitingCancel.add(resolve)
      })
      return { stopReason: 'cancelled' }
    }

    if (text.includes('crash')) {
      await say('about to fall over')
      // The client should surface this line with the exit, which is the whole
      // point of capturing the child's stderr rather than discarding it.
      process.stderr.write('mock-acp-agent: exploding on request\n')
      process.exit(3)
    }

    if (text.includes('ask-execute')) {
      // No command and no title, like a code-mode cell: nothing the shell gate
      // can classify, so the request reaches Copse's generic ACP prompt.
      const response = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId: 'mock-tool-execute',
          kind: 'execute',
          status: 'pending',
          rawInput: { cell: 'print(1)' },
        },
        options: [
          { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
          { kind: 'allow_always', name: 'Always allow', optionId: 'allow-always' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        ],
      })
      const outcome = response.outcome
      const decision =
        outcome.outcome === 'cancelled' ? 'cancelled' : `answered ${String(outcome.optionId)}`
      await say(`client ${decision}`)
      return { stopReason: 'end_turn' }
    }

    // ACP makes `kind` optional; both requests omit it. `run-kindless` also
    // carries a shell command, which the client must still gate as one.
    const kindless = text.includes('run-kindless')
    if (kindless || text.includes('ask')) {
      const response = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: kindless
          ? {
              toolCallId: 'mock-tool-2',
              title: 'Clean build output',
              status: 'pending',
              rawInput: { command: 'rm -rf build' },
            }
          : {
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
  .onNotification('session/cancel', () => {
    for (const resolve of awaitingCancel) resolve()
    awaitingCancel.clear()
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), readableFrom(process.stdin)))
