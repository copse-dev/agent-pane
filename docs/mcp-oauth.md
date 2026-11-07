# MCP OAuth sign-in

Remote (Streamable HTTP) MCP servers that protect themselves with OAuth, as the
[MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
describes, show **Sign-in required** in Settings → MCP servers with a **Sign in**
button. Code: `src/main/services/mcp/mcp-oauth.ts` (flow) and
`mcp-oauth-store.ts` (storage).

## Flow

1. A connect without credentials gets `401`. Copse reports the server as
   `auth: 'required'` instead of an error. Startup never opens a browser and
   never registers a client.
2. **Sign in** runs the SDK's `auth()`. It discovers the authorization server
   (RFC 9728 protected-resource metadata, then RFC 8414 metadata) and
   identifies Copse (see below). It then opens the authorization URL
   (http/https only) in the user's browser with an S256 PKCE challenge and a
   256-bit `state`.
3. The browser returns to a one-shot listener on `127.0.0.1` (RFC 8252). The
   listener ignores callbacks whose `state` does not match, and gives up after
   five minutes or when the user cancels.
4. The code is exchanged for tokens, the sign-in is stored, and MCP servers are
   reloaded.
5. Later connects attach the stored tokens, and the SDK refreshes them with the
   refresh token. If refresh is refused, the stored tokens are dropped and the
   server goes back to **Sign-in required**. A background connect cannot
   register a client or start a browser flow.

## Client identification

Copse follows the MCP spec's order of preference:

1. **A stored client**: reused only for the same redirect URI at the same
   authorization server ("Authorization Server Binding"). A registration is
   never presented to a different authorization server.
2. **Client ID Metadata Document**: when the authorization server advertises
   `client_id_metadata_document_supported`, Copse's client ID is the URL of
   its published document, `https://copse.dev/oauth/client-metadata.json`
   (source: `site/oauth/client-metadata.json`, deployed with the site from the
   `release` branch). There is no per-install registration.
3. **Dynamic client registration (RFC 7591)**: otherwise, with
   `application_type: "native"`.

The document lists fixed loopback callbacks (`127.0.0.1:47331–47333/callback`)
rather than port-less ones. Some servers (Linear among them) match redirect
URIs exactly instead of allowing any loopback port per RFC 8252 §7.3, and a
port-less listing fails there ("Invalid client"). When it uses the document,
sign-in listens on one of those ports.

Before using the document, sign-in fetches it and checks that it names itself
as its `client_id`. If it is unreachable (for example before a release has
published it), malformed, or all its ports are busy, sign-in falls back to
registration, so a missing document never breaks a server that registration
serves. That fetch is the one request to copse.dev; it carries nothing about
the user or the server.

Otherwise the listener prefers the port the client was registered with, and if
that port is taken it uses a free port and registers again.

## Storage and scope

- One record per server URL (fragment removed), under `mcpOAuth.<sha256(url)>`
  in `settings.json`. It holds the client registration, the redirect URI and
  the tokens. It is encrypted with the same keyring-backed cipher as provider
  keys (see [privacy-data-flow.md](privacy-data-flow.md#credentials)). With no
  keyring, sign-in refuses rather than store plaintext.
- Records are keyed and checked by URL, not by server name. A project
  `.mcp.json` that reuses a name for another URL cannot obtain the tokens.
- Sign-in only targets servers the current load was allowed to connect:
  trusted, enabled, HTTP, and without a configured `Authorization` header. A
  configured `Authorization` header always wins, and OAuth stays out of it.
- **Sign out** deletes the record and reconnects.

## Connections while changing projects

An admitted agent turn keeps its originating MCP connection, tool definitions,
read-only hints and exact permission identities until its work ends. Changing
the project shown in the window connects that project's servers for new turns;
it does not interrupt another project's pending call or route that turn's next
call through the newly selected project. A background turn starting offscreen
loads its own project's trusted configuration and default server directory.
Ordinary Copse tools and saved allow/ask/block policy remain live.

Native-tool bridge requests explicitly bind the same connection scope, including
approved agent-initiated turns. An outstanding request retains its connection
until it settles, even if the prompt binding ends first. Retired connections
close after their last owning turn or request releases them. No calls are
replayed when a project changes.

This retention applies only to project navigation. Explicit reconnect, server
disable/removal, configuration or trust changes, sign-out and application quit
still invalidate retained connections. Stop and request cancellation keep their
existing signals and permission checks. Turning off a bundled-server plugin
revokes that server without closing unrelated configured servers.
Queued turn admissions are tracked before connection work begins, so explicit
revocation also cancels them before they can reuse or start a server.
Admission cancellation covers initialization and tool discovery for configured
and bundled servers; Stop does not leave tool listing holding the lifecycle
queue for the next turn.

## Limits

- Servers that only admit approved clients refuse registration. Figma's remote
  server is one ("Only clients listed in the Figma MCP Catalog can connect"),
  and the error says that registration was refused.
- Tokens are not forwarded to external ACP agents. A remote server that needs
  OAuth is still handed to them without credentials.
- In sidecar mode the browser and the listener both run on the sidecar host, so
  sign-in works only when that host is the user's own machine.
