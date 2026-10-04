# Qwen Code ACP reference evidence

Measured on 2026-10-04 with the actual npm-distributed Qwen Code 0.24.7 CLI.
This completes the catalog and local protocol evidence for [#2304](https://github.com/copse-dev/agent-pane/issues/2304), but authenticated hosted-provider inference and its domain profile remain unverified.

## Catalog sources

- [ACP registry entry](https://github.com/agentclientprotocol/registry/blob/50f1621eb1e1283bb93d324e5497aeae8a4d935f/qwen-code/agent.json): id `qwen-code`, package `@qwen-code/qwen-code@0.24.7`, ACP flag `--acp`. The registry also enables optional experimental skills; Copse leaves that feature to the user.
- [Qwen authentication documentation](https://github.com/QwenLM/qwen-code/blob/6136786c0cbdfc9376243e3c524b22c6d374df47/docs/users/configuration/auth.md): OpenAI-compatible configuration uses `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL`. Run `qwen`, then `/auth` for current provider setup. The Qwen OAuth free tier ended on 2026-04-15; do not recommend it as a working first-run route.

## Unauthenticated hosted-provider blocker

Both repository probe commands ran against the real installed CLI with an empty isolated `QWEN_HOME`. `initialize` succeeded and advertised protocol 1, load/resume/list, image/audio/embedded context, HTTP/SSE MCP and OpenAI API-key authentication. `session/new` rejected with `Authentication required: Use Qwen Code CLI to authenticate first.` The [raw initialize exchange](acp-qwen-initialize-2026-10-04.json) preserves this distinction: the [support matrix](acp-qwen-support-2026-10-04.md) marks session negotiation failed, rather than presenting partial capabilities as a successful session. The [behavior matrix](acp-qwen-behavior-2026-10-04.md) records the same blocker, with no inference executed.

The managed environment had an enforced package-manager-only outbound policy and no configured provider credential or outbound identity. No hosted-provider credentials were invented and no hosted login or inference was attempted. HTTP/fetch/undici diagnostics recorded no network requests before the auth rejection. A hosted provider must be measured with an authorized account before claiming its endpoints or behavior are verified.

## Actual CLI with a local provider fixture

The CLI itself, ACP transport, session configuration and tool handling are real. Only the OpenAI-compatible inference server is a deterministic loopback fixture; its API key is an explicit local test value and its responses script one `write_file` call followed by completion. This establishes transport/tool compatibility, not model reasoning quality or hosted-provider support. The repository probes intentionally run unsandboxed; these runs do not establish platform confinement.

- [Support matrix](acp-qwen-local-support-2026-10-04.md): protocol 1; session load, resume and list advertised; modes `plan`, `default`, `auto-edit`, `auto`, `yolo`; one configured model; 53 slash commands observed. Advertising session methods does not prove cross-directory continuity.
- [Behavior matrix](acp-qwen-local-behavior-2026-10-04.md): one `fs/write_text_file`, no execute calls, no permission requests, stop reason `end_turn`. Qwen supplied `toolName` and provenance metadata, so no speculative per-agent tool-name patch was added.
- [Network trace](acp-qwen-network-2026-10-04.json): only POST `http://127.0.0.1:18883/v1/chat/completions`. No headers, API keys or prompt contents are recorded. The catalog grants no external domains; Copse's existing ACP sandbox permits loopback when its native bridge is enabled.

## Hosted endpoint configuration

There is currently no network-domain editor in the ACP Settings form. Its supported advanced configuration is the registered agent's `sandbox` object in `~/.copse/user-data/settings.json` (`COPSE_DIR` changes the profile root). Stop Copse before editing that file; preserve the other settings and the existing agent fields. Set that agent's `sandbox` object to `{"allowedDomains":["your-observed-provider-host"],"homeDirs":[".qwen"]}` only after checking the actual provider and token endpoints. This overrides the catalog profile; it does not change other agents. Do not use wildcards inferred from Qwen's model name. Re-run both probes with an authorized provider and commit the resulting hosted rows before closing #2304.

## Reproduce the local evidence

Install `@qwen-code/qwen-code@0.24.7` into an isolated prefix and put its `node_modules/.bin` on PATH. Set `QWEN_HOME` to an empty writable directory outside the checkout. Save the following fixture as a temporary `.cjs` file, set `QWEN_FIXTURE_WORKSPACE` to this checkout's absolute path, and start it with Node 24. It never contacts an external provider.

```js
const http = require('node:http')
const { appendFileSync } = require('node:fs')
let turns = 0
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    let input
    try {
      input = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }
    const tools = input.tools || []
    const write = tools.find((tool) => tool.function?.name === 'write_file')
    appendFileSync(
      '/tmp/qwen-local-provider-trace.jsonl',
      JSON.stringify({
        method: req.method,
        host: req.headers.host,
        path: req.url,
        model: input.model,
        stream: input.stream,
        tools: tools.map((tool) => tool.function?.name),
        writeParameters: write?.function?.parameters,
      }) + '\n',
    )
    const first = write && !input.messages.some((message) => message.role === 'tool')
    const value = first
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'qwen_fixture_write',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  file_path: process.env.QWEN_FIXTURE_WORKSPACE + '/.copse-acp-behavior-probe.txt',
                  content: 'PROBE_OK',
                }),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'Created .copse-acp-behavior-probe.txt with PROBE_OK.' }
    const envelope = {
      id: 'qwen-local-fixture-' + ++turns,
      object: 'chat.completion',
      created: 1,
      model: input.model,
      choices: [{ index: 0, message: value, finish_reason: first ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
    if (input.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = first
        ? { role: 'assistant', tool_calls: [{ index: 0, ...value.tool_calls[0] }] }
        : value
      res.write(
        'data: ' +
          JSON.stringify({
            ...envelope,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: null }],
          }) +
          '\n\n',
      )
      res.write(
        'data: ' +
          JSON.stringify({
            ...envelope,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }],
          }) +
          '\n\n',
      )
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(envelope))
    }
  })
})
server.listen(18883, '127.0.0.1', () => process.stdout.write('local fixture ready\n'))
```

In another shell, set `OPENAI_API_KEY=local-fixture-key-not-a-provider-credential`, `OPENAI_BASE_URL=http://127.0.0.1:18883/v1`, and `OPENAI_MODEL=copse-local-fixture` for these commands only:

```sh
COPSE_DEBUG_ACP_UPDATES=1 pnpm run probe:acp -- --agent qwen-code --out docs/acp-qwen-local-support-2026-10-04
COPSE_DEBUG_ACP_UPDATES=1 pnpm run probe:acp:behavior -- --agent qwen-code --timeout 20000 --out docs/acp-qwen-local-behavior-2026-10-04
```

Stop the fixture afterwards. The saved matrix rows are references from this run, not CI assertions and not evidence of a paid hosted model.
