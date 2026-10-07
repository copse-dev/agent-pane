# Managed remote agents

Copse can hand a chat turn to a **provider-managed** remote agent instead of running
the local tool loop. Today that means:

| Model value                                           | Provider                      | Adapter                                             |
| ----------------------------------------------------- | ----------------------------- | --------------------------------------------------- |
| `remote-agent:cursor` / `remote-agent:cursor#…`       | Cursor Cloud Agents           | `src/main/services/remote/remote-agent-client.ts`   |
| `remote-agent:anthropic` / `remote-agent:anthropic#…` | Claude Managed Agents         | `src/main/services/remote/managed-agents-client.ts` |
| `remote-agent:openai#gpt-6.1-sol`                     | OpenAI Agents API (prototype) | `src/main/services/remote/openai-agents-client.ts`  |

Shared prompt/SSE helpers live in `src/shared/remote-agent-stream.ts`. Copse owns the
local transcript projection (`StreamChunk`), thread ↔ agent link store, handoff
preamble, and artifact/PR surfacing. The provider owns the guest VM, egress, and
retention.

## OpenAI prototype

Save an OpenAI **Platform API key** in Settings, open a project, and select
**OpenAI Cloud Agent (prototype · API billed · no ZDR)** in the model picker.
ChatGPT OAuth does not authorize this integration. The key needs Agents read/write
and Responses write permissions. Hosted sessions retain data in the US and are
not eligible for Zero Data Retention. Model usage appears in the chat; container
and tool charges are additional, so that display is not the complete invoice.

The provider runs a separate OpenAI-hosted workspace. Local files and credentials
are not mounted or uploaded. Copse supplies the current project's GitHub URL,
branch, and commit on each new turn, directing the agent to clone that revision
and return a patch under `/workspace/outputs`. Existing sessions receive this
context too. Local uncommitted edits and unpushed commits are unavailable; the
agent must report an unavailable revision rather than silently changing bases.
Private repositories,
automatic PR creation, images, approval-required tool flows, and automatic
background recovery are outside this prototype.

Follow-ups reuse the same hosted session. A private checkpoint lives alongside the
native thread. After an interrupted request, resend the **same message** to recover
the pending turn before sending a different task. Keys/models cannot change within
an existing session. The client subscribes before submission but uses saved turns
and items as the recovery authority: OpenAI event streams do not replay. Progress
currently displays polled command output and completed messages, not token deltas.
Stop requests remote cancellation and checks that work has ended; an unconfirmed
cancellation is surfaced as an error. If cancellation is confirmed but recovery of
output, usage, or artifacts fails, Copse reports that distinction and retains the
pending checkpoint. Resend the previous message to recover it before starting a
different task. Runs have a ten-minute prototype limit.

Artifacts download into the thread's blob directory (10 MiB per file, 20 files,
50 MiB per turn). Artifact links open a Save dialog rather than the workspace
index, including links in older messages. Remote paths never choose local filenames. Deleting local chat
state does not delete its hosted session. Manage remote retention separately.

The supplied commit belongs to the local chat checkout; it is not necessarily
the latest remote branch tip. The hosted agent is instructed to refresh and
compare both revisions on every turn, and ask before editing if they differ.
This remains agent-enforced rather than a verified checkout synchronization
protocol. Patches are exported deliverables, not automatically applied edits.

For a standalone billable smoke test, configure `OPENAI_API_KEY` in the process
environment, then run:

```sh
pnpm run probe:openai-agents
pnpm run probe:openai-agents --prompt 'Inspect the script from the previous turn.'
pnpm run probe:openai-agents --resume
pnpm run probe:openai-agents --delete
```

The default task writes and executes a tiny Python artifact. `--resume` only applies
to pending work; `--delete` removes the probe's remote session after it stops.
`--state PATH` selects a separate checkpoint. Keep checkpoints private: they include
pending prompts, though never the API key. See the
[prototype plan and validation record](plans/openai-cloud-agent-prototype.md).

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
2. **License / boundary** — Copse is AGPL-3.0-only. Calling the public Cloud Agents
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
