# Sandboxed remote artifact image hydration

Status: implemented for Cursor; Linux partially validated (seccomp Unix-socket filter off);
macOS unvalidated. Main no longer fetches image bytes; downloads run in a per-job host and an
ASRT-confined downloader. The Linux runs used a host that cannot apply ASRT's seccomp filter (see
the validation record below), and confirmation of Cursor's download origin against an
authenticated fixture is still open, so full containment is not yet claimed on either platform.
Tracking: [#4005](https://github.com/copse-dev/agent-pane/issues/4005).

## Outcome

Rendering a remote artifact image may contact only the configured provider's
artifact API and approved public image-download destinations. Image bytes are
downloaded in an ASRT-confined subprocess with no provider credentials, workspace
access, or access to the user's profile. A failed policy check or unavailable
sandbox leaves the image unavailable; it never retries through main-process fetch.

This applies to automatic remote-artifact image hydration. Generated HTML canvas
networking and Trusted Types enforcement are separate work. Explicit artifact
links remain a separate user-initiated feature and must not become an automatic
fallback for failed hydration.

## Path before #4005 and evidence

This records the path the design replaced; the validation record below describes what ships.

- `src/renderer/markdown/artifact-image-policy.ts` accepts artifact-shaped raw image
  sources and emits inert placeholders. An apparent URL's hostname is not used to
  authorize the artifact.
- `src/renderer/markdown/remote-artifact-images.ts` takes agent identity from an
  image attribute or a matching transcript link, then calls IPC automatically.
- `src/main/ipc/register-handlers.ts` checks the main-frame sender and argument
  lengths, then calls `fetchRemoteArtifactImageDataUrl` directly.
- `src/main/services/remote/remote-agent-client.ts` validates the configured API
  base and artifact path, resolves a download URL with provider authentication,
  and fetches that URL using native main-process `fetch`. The second fetch has no
  destination/redirect policy. It checks image MIME and a 15 MiB limit, but fully
  buffers the body before the final size check.
- `src/main/project-sandbox/index.ts` initializes ASRT for wrapped subprocesses;
  it does not confine the main process's native HTTP requests.

See [shell permissions](../shell-permissions.md) and
[network scope isolation](sandbox-network-scope-isolation.md).
The latter establishes why a new download must not widen the Electron main
process's shared ASRT network scope.

## Decisions and trust boundaries

1. Keep authenticated provider API calls in the trusted main process.
2. Create one short-lived download host per admitted download. The host owns its
   ASRT instance, a restricted egress proxy, and one sandboxed downloader child.
3. The host is trusted infrastructure, not itself the sandboxed downloader.
   Calling `SandboxManager.initialize` does not sandbox the calling process.
4. Authorize the artifact against durable project/thread/provider metadata before
   requesting a signed URL. Transcript text supplies a path, not authority.
5. Use an explicit provider download-origin policy, plus public-address checks at
   connection time. A returned URL does not authorize its own destination.
6. Never share a job's proxy, credentials, or mutable allowlist with another job.
7. Do not silently fall back to unsandboxed execution on Windows, sandbox startup
   failure, or a containment violation.
8. Signed download URLs are bearer secrets. Keep them out of renderer state,
   process arguments, environment variables, persisted logs, and error strings.

```mermaid
flowchart TD
  R["Renderer: project, thread, artifact path"] --> M["Main: authorize artifact"]
  M --> A["Configured provider API: authenticated URL resolution"]
  A --> V["Main: validate download URL and origin policy"]
  V --> H["Per-download trusted host: ASRT manager + restricted proxy"]
  H --> W["ASRT-confined downloader: no provider credentials"]
  W --> P["Proxy: approved host, port and pinned public address"]
  P --> O["Approved image origin"]
  W --> B["Bounded image bytes"]
  B --> M
  M --> D["Renderer receives validated data: image"]
```

The parent renderer CSP still governs displaying the data URL. Neither that CSP
nor Chromium's renderer sandbox supplies confinement for native HTTP.

## Authorization and IPC

Replace the hydration request's bare `agentId, path` pair with a schema-decoded
`{ projectId, threadId, path, agentId? }`. The optional agent ID selects among
durable links already belonging to that thread; it is never independently trusted.

The main process must:

- Validate the sender and resolve the requested thread within its project.
- Derive provider, account/configuration identity, and linked remote agent IDs from
  native thread/session records. Do not use whichever project is currently active
  when an asynchronous request completes.
- Require an exact linked-agent match. With no selector, accept only an unambiguous
  linked agent. Do not infer identity from a `cursor.com/agents/...` text match.
- Normalize and validate a relative `artifacts/` path once; reject traversal, NUL,
  absolute paths, backslashes, and ambiguous separator encodings. Do not repeatedly
  decode a path. Encode the validated path as one API query parameter.
- Reject before any network request if provenance is absent or inconsistent.

Existing launch-link persistence is best-effort. Old threads with missing links
therefore need a trusted migration from stored remote-session records or an
explicit remote-agent import/link action. Never repair provenance from model text.
Multiple historical runs in a thread remain supported through exact linked IDs.

This is a supported IPC change for the real renderer, not a test-only switch.
Update preload types, decoders, renderer call sites, and component fixtures together.

## Provider API resolution

The main process calls the configured provider's existing artifact endpoint with
its credential. Apply a bounded response size and timeout and decode the response
schema. Reject HTTP redirects on this credential-bearing metadata request; any
provider needing a different endpoint must configure that endpoint explicitly.

The signed URL is then checked against provider-owned download policy:

- HTTPS only, port 443, no userinfo, no fragments, no IP-literal destinations.
- Exact canonical origins supplied by the provider adapter or explicit supported
  user configuration. Do not reuse the broad web-tool allowlist, grant wildcard
  cloud-storage domains, or automatically allow the hostname from the response.
- Unknown origins fail closed with a bounded error naming only the origin.
- A custom provider requires an explicit download-origin configuration through its
  settings/import surface. Configuring its API origin alone does not authorize
  arbitrary download origins. Do not add a renderer-writable per-request allowlist.
- Signed path/query bytes must survive validation and transport without
  reconstruction that invalidates signatures.

Before shipping, establish the real provider storage origins and redirect patterns
from provider documentation or a controlled authenticated fixture. The repo evidence
does not establish those domains, so this design intentionally invents none.
Local custom APIs may retain their existing metadata-access contract, but automatic
image downloads from private/loopback origins are unsupported in this first version.

## Download host, ASRT, and actual socket policy

Follow the process/lifecycle shape of
`services/acp/acp-session-host.ts` and `acp-session-host-worker.ts`, but do not
copy their broad inherited environment or their agent configuration surface.

Main starts a fixed bundled host executable using an absolute trusted runtime path,
a minimal environment, a private scratch directory, and a parent IPC channel.
It sends a single schema-decoded job after startup. No shell command, executable,
filesystem roots, headers, or sandbox configuration can come from the renderer.

The host initializes its own ASRT manager and supplies a per-job external proxy
through ASRT's supported proxy configuration. It then starts the fixed bundled
downloader inside ASRT. The downloader has:

- Runtime/bundle/system-library reads required to start, but no workspace, profile,
  credentials, or arbitrary home-directory reads.
- No writes except its private scratch directory if the runtime requires one.
- No direct outbound sockets, arbitrary Unix sockets, or listening sockets.
  Only the ASRT-required route to this job's proxy is permitted.
- An explicitly constructed environment: no API tokens, SSH agent, inherited
  proxy bypass variables, `NODE_OPTIONS`, custom CA overrides, or user startup files.
- No renderer preload, Electron APIs, or dynamic code supplied by the artifact.

Build a download-specific sandbox profile. Do not reuse an entire project overlay,
which grants workspace access. Package host and downloader as explicit build inputs
and verify their emitted bundles in the complete-dist checks.

The proxy is a security boundary, not an unrestricted local relay. It authenticates
the job, permits only its approved exact hostnames on port 443, and exposes only the
CONNECT/tunnel functionality needed by the client. Reject unsupported HTTP methods,
malformed authorities, alternate address forms, and unauthorized proxy requests.
Disable unused SOCKS transport; if the ASRT backend needs it, enforce the identical
policy there. No unauthenticated forwarding listener is permitted.

For every new upstream connection, the proxy resolves the requested hostname,
rejects the destination if any returned address is non-public, selects a vetted
address, and connects to that numeric address without a second DNS lookup. Cover
IPv4, IPv6, mapped addresses, loopback, private/link-local, unspecified, multicast,
metadata, and other non-global ranges. Retain the original hostname for TLS SNI
and certificate verification in the downloader's TLS connection. Never disable TLS
verification to support address pinning.

A DNS preflight in main followed by ordinary proxy hostname resolution is insufficient.
Likewise, ASRT's hostname allowlist alone is not evidence of public-address pinning.
The downloader must use an explicit CONNECT-aware HTTPS transport; do not assume
Node's native `fetch` follows proxy environment variables.

Implementation must first prove this external-proxy wiring and confinement with the
pinned ASRT version on macOS and Linux. If an ASRT backend cannot express the required
route/filesystem restrictions, that backend does not support hydration until a
tested implementation exists. There is no fallback that weakens these invariants.

## Redirects, HTTP, and image validation

The downloader issues only GET requests and handles redirects manually:

- At most three redirects, within the original total deadline.
- Resolve each Location against the current URL, then reapply the complete
  scheme/origin policy before attempting the next request.
- Cross-origin redirects require a destination already in the approved policy.
  No HTTPS downgrade, private destination, userinfo, or unbounded loop is allowed.
- Each connection goes through the proxy's DNS/pinning checks, including retries.
- Send no Authorization, cookies, Referer, or inherited headers. A signed URL may
  contain the download token; it does not confer provider API credentials.
- Disable automatic retries initially. A bounded user retry reruns authorization
  and obtains a fresh signed URL rather than replaying an expired URL.
- Request identity content encoding and reject unexpected content encodings in the
  first implementation, avoiding an unbounded decompression step.

Preserve the current 15 MiB maximum, enforced while reading the stream even if
Content-Length is absent or dishonest. Also bound headers, reject non-success
statuses without including response bodies in errors, and stop on the first overrun.

Accept PNG, JPEG, GIF, and WebP only. Check their signatures against the supported
format and claimed MIME; reject SVG, HTML, generic `image/*`, and mismatches.
Perform bounded header inspection for dimensions: initially cap either dimension
at 16,384 and total pixels at 40 million. Keep actual image decoding in Chromium's
image-rendering context; signature/header checks are not a complete decoder audit.
Animation resource limits remain a separate decoder concern.

The host relays bounded byte chunks to main. Main verifies the result schema, job
identity, total byte count, supported MIME, and complete-success marker before
creating a data URL. Partial output must never be displayed or cached.

## Lifecycle, limits, and cache

Initial constants, subject to measured provider compatibility:

| Limit                      | Initial value                           |
| -------------------------- | --------------------------------------- |
| Concurrent download jobs   | 2 app-wide, 1 per thread                |
| Queued jobs                | 16 app-wide, deduplicated               |
| Provider metadata response | 64 KiB, 10 seconds                      |
| Host startup               | 10 seconds                              |
| Download deadline          | 30 seconds including redirects          |
| Response headers           | 32 KiB                                  |
| Image bytes                | 15 MiB                                  |
| Redirects                  | 3                                       |
| Worker protocol frame      | 64 KiB payload, bounded before decoding |
| Result cache               | Existing 64 MiB / 64-entry ceilings     |

A short-lived host handles exactly one job, then shuts down its child, tunnels,
proxy, and ASRT manager. Do not pool hosts or union policies in the first version.
Main tracks the complete process tree and kills it on timeout, invalid protocol,
shutdown, or cancellation. Parent-channel closure triggers cleanup in the host.
Include abrupt parent death and orphan cleanup in native validation.

Tie renderer requests to disposable subscriptions. Switching/unmounting a thread
releases its subscriptions; cancel a shared job when its last subscriber leaves.
Recheck authorization before serving cached results. Cache and in-flight keys include
project, thread, provider, API origin, credential/account generation, agent ID, and
artifact path. Invalidate on credential/provider changes, unlink, deletion, and
explicit refresh; an old in-flight completion must not repopulate an invalidated
cache. Never use a signed URL or raw credential as a cache key or persist either.

Use schema-decoded, versioned messages with a main-generated request ID. Bound input
before JSON decoding, validate chunk order and aggregate size, and reject duplicate
completion or bytes after completion. Parent and host validate independently.
Use `safeJsonParse(text, decodeWithSchema(schema))` for JSON boundaries.

## Failure behavior and diagnostics

Keep the transcript responsive and preserve the image's alt text. Provide a concise
unavailable state and explicit retry for transient failures. Sandbox-unavailable,
unlinked-agent, and denied-origin errors do not offer an unsandboxed retry.

Log request ID, provider, outcome, approved/denied origin, elapsed time, and byte count.
Do not log signed URLs, query strings, cookies, authorization values, response bodies,
or raw network error messages that may embed URLs. Decode failures to bounded error
codes before they cross into renderer logs.

On Windows or unavailable macOS/Linux ASRT, automatic hydration remains unavailable.
Explicit artifact links continue as their separate user-initiated feature; do not
label that browser/download path as sandboxed hydration.

## Implementation sequence and acceptance evidence

1. **Transport feasibility and provider policy.** Prove external-proxy integration
   against pinned ASRT and record actual provider origins. This gates subsequent
   integration; it must not become a permissive runtime fallback.
2. **Authorization and pure policy.** Add durable thread selection, origin/path
   decoders, public-address classification, cache identity, and bounded protocol.
3. **Host and downloader.** Add isolated ASRT lifecycle, proxy pinning, manual
   redirects, streaming limits, and build outputs. Inject transport/process
   dependencies at module boundaries for deterministic tests.
4. **Hydration integration.** Replace automatic byte-fetch use of native fetch,
   wire supported IPC and disposal, and present failure/retry states.
5. **Native and visual validation.** Complete the checks below, then update
   `docs/shell-permissions.md` to document the shipped hydration contract.
   Update this design's status only when its invariants have been demonstrated.

Unit/component evidence must cover unauthorized agents before network, spoofed
transcript identity, traversal, origin mismatch, credential rotation, stale results,
redirect loops/downgrades, DNS rebinding and mixed address answers, TLS name checking,
over-limit chunked bodies, unexpected encodings/MIME, malformed protocol, and every
timeout/cancellation cleanup path. Assert credentials never enter child requests,
environment, arguments, or diagnostic output.

Native containment tests must run on macOS and Linux and prove:

- A permitted download succeeds through the real ASRT-confined child and proxy.
- The child cannot bypass the proxy, reach private/loopback destinations, open
  unrelated sockets, or read a workspace/profile sentinel.
- No other shell or ACP job gains the download host's allowlist.
- A killed host/parent leaves no child, listener, tunnel, or widened scope.
- Tests exercise rebinding at the actual resolver/connect boundary, not just URL
  parsing, and retain TLS verification while connecting to the pinned address.
- Missing ASRT fails before image network access with no native-fetch retry.

Use controlled endpoints and injected resolver/provider fixtures at dependency
boundaries. Do not introduce production flags granting tests private destinations.
Add the smallest focused Electron WebdriverIO spec using real IPC for a successful
image and an unavailable/retry state, assert relevant DOM behavior, and save a
screenshot. Follow the screenshot-validation skill when implementing that UI change.
Use the test oracle and `pnpm run check` before committing implementation.

## Validation record (2026-10-30, #4005)

Where the code lives: `src/main/services/remote/artifact-image/`. `policy.ts` and
`image-signature.ts` hold the pure checks, `protocol.ts` the bounded frames and the verifier both
sides run, `egress-proxy.ts` the job proxy, `downloader.ts` the confined client, `host.ts` the
per-job lifecycle, and `service.ts` authorization, queueing and cache.

**Pinned ASRT (0.0.74) external-proxy wiring.** Setting both `network.httpProxyPort` and
`network.socksProxyPort` to the job proxy stops ASRT starting its own mux proxy. On Linux it
bridges both ports into the bwrap network namespace (`localhost:3128` and `:1080`) over Unix
sockets. With a real bwrap run, the confined child reached only the job proxy, which saw an
unauthenticated `CONNECT` and refused it. A direct connection to the internet failed with
`ENETUNREACH`, host loopback was unreachable, and a denied read sentinel was absent.

**Findings that changed the implementation:**

- ASRT creates its Linux bridge sockets in the temp directory, and this profile denies reads of
  it. Without re-allowing exactly those two socket paths, the in-namespace socat has nothing to
  connect to and every download fails. `host-entry.ts` re-allows them.
- ASRT starts the in-namespace socat bridge in the background. A child that connects immediately
  gets `ECONNREFUSED`, so the downloader retries its proxy connection only, for up to 3 seconds.
- ASRT's parent-proxy discovery copies the host's `HTTPS_PROXY` into `JAVA_TOOL_OPTIONS`.
  Main therefore starts the host with an environment built from scratch (`PATH`, `HOME`,
  `TMPDIR`, `ELECTRON_RUN_AS_NODE`), and the host builds the downloader's from scratch too.
- Egress-policy tests caught `canonicalDownloadOrigin` accepting `https://*.amazonaws.com`: the
  URL parser allows `*`, and ASRT honours a wildcard allowlist entry. Origins are now checked
  against a strict DNS-name pattern.
- The downloader trusts only the runtime's bundled roots. Behind a TLS-intercepting proxy
  (enterprise inspection, or this session's egress gateway) hydration fails closed as `tls`.
  This is the intended behaviour, not a fallback gap.

**End-to-end run.** The production host job, egress proxy, ASRT and the built downloader bundle
ran under real bwrap against `https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com`. The proxy
logged `egress allowed` for the S3 host and the tunnel carried the TLS handshake, which failed
closed as `tls` because the session's gateway re-signs TLS. The run used two container-only
workarounds that production does not have: socat forced to IPv4 (the kernel has no IPv6 in new
namespaces) and seccomp's Unix-socket filter off (`apply-seccomp` cannot create a nested user
namespace there; the repo's own real-sandbox tests fail the same way on that host).

**Provider origin.** `CURSOR_ARTIFACT_DOWNLOAD_ORIGINS` holds one exact origin,
`https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com`. A third-party report of Cursor's
presigned artifact URLs names it, and so does the repository's existing test fixture. Cursor's
own documentation could not be read from the implementing session. Confirm the origin and any
redirect pattern with an authenticated fixture. A different real origin fails closed as
`origin-denied` naming that origin; the fix is to correct the list, never to widen it.

**Not yet done from this design:**

- macOS native containment tests (seatbelt with an external proxy, no bypass, sentinel reads).
- An abrupt parent-death and orphan test on a real process tree. Unit tests cover cancellation
  and the host deadline. The host cancels when stdin closes, and the downloader stays in the
  host's process group, which main signals as a whole.
- Renderer subscriptions that cancel a shared job when the last viewer leaves. Jobs are instead
  bounded by the queue, deduplication and deadlines.
- A trusted provenance migration for old threads without `remoteAgentLink`. Their images fail
  closed as `unlinked-agent`. The thread store keeps one current link per thread, so an image
  from an earlier, replaced agent link is also refused.
- Download-origin configuration for custom providers. Only Cursor links hydrate; other providers
  answer `unsupported-provider`.

**Independent security review (2026-11-01).** A read-only review of the implementation found no
SSRF, signed-URL leak or self-approving origin. Its findings fixed in #4030:

- The authorization anchor was renderer-writable. `threads:create` and `threads:update-meta` now
  strip `remoteAgentLink` (`src/main/ipc/thread-meta-guard.ts`), so a renderer can neither forge
  a link nor erase one by sending a stale `undefined`. Only main records it, on launch or import.
- Linux status is "partially validated": every Linux run had seccomp's Unix-socket filter off.
  `host-native.test.ts` now runs the real profile and ASRT adapter wherever ASRT can start a
  sandbox. It checks that the child reaches only its proxy, cannot reach host loopback or the
  internet directly, and cannot read a sentinel. It skips, saying why, where ASRT cannot start.
- `denyRead` names the common project and data roots (`/home`, `/workspace`, `/srv`, `/opt`,
  `/mnt` and others), not only home and temp, since it is a denylist over a readable system.
- An error frame's origin must be a strict canonical origin before main logs it, and only the
  last chunk of an image may be short, which bounds the frame count.
- Host teardown waits for the downloader to exit, even one that ignores SIGTERM, before closing
  the proxy and resetting ASRT. A downloader that exits without any output is reported as
  `sandbox-unavailable` rather than a retryable error.
- Non-retryable failures are remembered for a minute after authorization, so re-renders do not
  refetch. Cache invalidation was removed: every read re-authorizes against the durable link,
  and the key carries the credential generation and API origin.

**Residual risks, not fixed here:**

- The older explicit-download IPC (`remote-agent:download-artifact`) still returns a signed URL
  to the renderer for any agent ID, with no thread authorization. It is a separate, user-initiated
  path and needs its own change.
- A path-only image (`artifacts/…` with no agent in the URL) resolves against the thread's
  _current_ link, so after a relaunch it may name a newer run's artifact of the same path.
- Inside an approved tunnel, a compromised downloader could send any `Host` header to the same
  S3 endpoint and so reach another bucket on the same certificate. The downloader holds no
  credentials or workspace data, so it could leak only what it already has: the signed URL and
  the image.
- NAT64/DNS64 and split-horizon answers fail closed as non-public. The proxy dials only the
  first vetted address. The single, unconfirmed S3 origin is a regression risk if Cursor uses
  another one.
- ASRT may leave its Linux bridge sockets in the temp directory after a SIGKILL.
- Electron's RunAsNode fuse: the host and downloader run as `ELECTRON_RUN_AS_NODE`, so a build
  that disables that fuse needs another launch method.

## Remaining implementation gates and tradeoffs

The security contract above is decided; these facts still require verification:
the provider's real download origins/redirects, pinned ASRT's external-proxy behavior
on both supported platforms, and the minimum packaged-runtime filesystem reads.
Record the results here before claiming containment.

The cost is a short-lived host and sandbox startup per image plus stricter legacy
thread/custom-provider behavior. Deduplication, bounded concurrency, and the existing
memory cache limit that cost. Prefer this explicit behavior to shared allowlist
widening or silently fetching an untrusted destination in main.
