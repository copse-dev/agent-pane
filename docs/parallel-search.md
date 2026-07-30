# Parallel Search pack

`copse.parallel-search` is a default-off, first-party pack that gives the agent a
native `parallel_search` tool. Copse sends requests directly to
`https://api.parallel.ai/v1/search`; there is no MCP process or MCP server in the
request path.

## Setup and lifecycle

1. Open **Settings → Packs → copse.parallel-search**.
2. Save a Parallel API key. Copse uses the existing encrypted API-key store; the
   key is never exposed through `packs:list` or generic pack settings. The
   `PARALLEL_API_KEY` environment variable is also supported.
3. Choose the default search mode (`turbo`, `basic`, or `advanced`) and enable
   the pack.

The live tool registry requires both enablement and a resolved key. Saving or
clearing the key and toggling the pack synchronizes the registry immediately,
without restarting Copse. Disabling the pack removes the tool from new turns but
does not erase the saved key or historical tool cards.

## Request and response contract

Each call sends an objective, one to five focused search queries, and a mode.
Responses are decoded before use and rendered as ranked
titles, URLs, publish dates, and excerpts. Output is capped before returning to
the model. The API key is sent only in the `x-api-key` header and is never
included in tool output.

The tool treats returned excerpts as untrusted web content and tells the model
to cite the returned URLs. Authentication, credit, rate-limit, malformed
response, timeout, and cancellation failures surface as bounded tool errors.

## Security, privacy, and cost

The first call is routed through Copse's web-origin permission gate for
`api.parallel.ai`. Users can approve once or remember that origin. Read-only
agent mode blocks the call because it is a network operation.

Search objectives and queries leave the device and requests may consume paid
Parallel API credits. Enabling the pack does **not** enable Zero Data Retention.
ZDR is a property of the user's Parallel account or enterprise agreement and
must be confirmed with Parallel separately.
