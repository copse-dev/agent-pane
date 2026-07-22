# Managed remote agents

Copse can hand a chat turn to a **provider-managed** remote agent instead of running
the local tool loop. Today that means:

| Model value                                           | Provider              | Adapter                                             |
| ----------------------------------------------------- | --------------------- | --------------------------------------------------- |
| `remote-agent:cursor` / `remote-agent:cursor#…`       | Cursor Cloud Agents   | `src/main/services/remote/remote-agent-client.ts`   |
| `remote-agent:anthropic` / `remote-agent:anthropic#…` | Claude Managed Agents | `src/main/services/remote/managed-agents-client.ts` |

Shared prompt/SSE helpers live in `src/shared/remote-agent-stream.ts`. Copse owns the
local transcript projection (`StreamChunk`), thread ↔ agent link store, handoff
preamble, and artifact/PR surfacing. The provider owns the guest VM, egress, and
retention.

## Cursor stream resume

Cursor run streams are run-scoped SSE
(`GET /v1/agents/{agentId}/runs/{runId}/stream`). The API documents resume via the
`Last-Event-ID` header and may emit recoverable `error` events such as
`stream_unavailable` ("Run stream is no longer available") while the agent keeps
working. After the stream retention window, the endpoint may return HTTP `410`
(`stream_expired`); clients should then read terminal state from Get A Run.

Copse reconnects on recoverable drops (including `stream_unavailable`), sends
`Last-Event-ID`, dedupes replayed event ids, and falls back to Get A Run / polling
when the stream is gone or the reconnect budget is exhausted. Only
`unauthorized` / `forbidden` / `not_found` SSE error codes are treated as fatal
(same set as `@cursor/sdk`).

## Why not `@cursor/sdk`?

We evaluated switching the Cursor adapter to [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk)
and kept the thin REST client instead:

1. **Surface area** — Copse only needs cloud create / follow-up / stream / cancel /
   usage / artifacts. The SDK also ships a local agent runtime, optional native
   platform packages, ConnectRPC, and Statsig — large for an Electron app that
   already has its own agent loop.
2. **License / boundary** — Copse is Apache-2.0. Calling the public Cloud Agents
   API with the user's Cursor API key is a clearer shipping boundary than bundling
   Cursor's proprietary SDK (ToS-licensed) into the desktop binary.
3. **Impedance mismatch** — We still need an adapter onto Copse `StreamChunk`,
   session persistence, first-handoff context preambles, artifact summaries, and
   the agent ↔ PR link store. The SDK's `SDKMessage` / `run.stream()` model does
   not remove that seam.
4. **Multi-provider adapter** — Anthropic Managed Agents stays on its own HTTP
   client. An SDK would not unify the remote-agent dispatcher.
5. **Testability** — The REST adapter injects `fetchImpl` for deterministic unit
   tests; a full SDK would be harder to mock at the same boundary.

We treat `@cursor/sdk` as a **reference implementation** for reconnect semantics
(and re-check it when Cursor changes stream error codes), not as a runtime
dependency. Revisit only if the REST docs lag badly or we need much more of the
SDK surface.
