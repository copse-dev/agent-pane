# Browser network policy

The agent's browser tools enforce `webAllowedOrigins` at the Electron session
request boundary. This is the same allowlist used for web tools, including wildcard
hosts and ports. An explicitly empty network allowlist denies all agent-browser
network requests. The old `browserAllowedOrigins` setting no longer grants
separate network access.

The visible Browser pane is user-controlled and loads ordinary public HTTP(S)
documents, redirects, embedded resources and WebSockets without applying the
agent allowlist. Both profiles still deny private/link-local targets, requests
without an owning page, and privileged URL schemes. Restricted prototype documents
remain same-origin only. For agent sessions, both the browser and web approval
settings must permit approval before a new origin can prompt. A remembered
navigation approval adds the origin to the network allowlist; a one-time approval
lasts for this app session and belongs only to its task.

Browser partitions and automation tab managers are scoped by project and task.
Interactive and agent browser profiles remain separate. Existing tabs keep their
original owner when the selected task changes; popup tabs inherit that owner.
Tab persistence, pop-outs and agent preview promotion preserve that scope too.

Copse-owned static prototypes send a CSP from their preview server. It allows
resources from the page's own origin, inline scripts/styles and embedded data/blob
images, but denies external origins, frames, workers, plugins and base URL changes.
A network approval does not relax this prototype CSP: bundle assets locally.
The prototype's loopback IP aliases retain its same-origin navigation restriction.

Ordinary HTTP(S) pages retain only the CSP supplied by their server. Pages opened
in the visible, user-controlled browser load public-web documents and subresources
normally, including in fresh tabs. Private and link-local targets remain blocked.
Agent-controlled `browser_navigate` sessions remain isolated from the user's
cookies and continue to require an origin grant for every network request.

HTML artefacts prepend their restrictive CSP before untrusted markup. Data URL documents
have no network access even if their HTML omits the CSP, including access to
allowlisted hosts and localhost. A request is attributed to a data: frame only when
its initiator origin is opaque or absent: a frame's committed URL can still name the
previous data: preview when the next document's first subresources arrive, and a
data: document never has a real origin. Direct browser navigation supports HTTP(S) only. Workspace file previews use
the existing static preview server, so relative files load from its loopback
origin under the same policy. This does not enable arbitrary file URL browsing;
file documents, if encountered, cannot make network requests.

Validation: `browser-network-policy.test.ts` covers the request matrix and HTML
artefact CSP; `static-preview-server.test.ts` covers the static prototype CSP;
`browser-network-grants.test.ts` and the permission-gate tests cover task
isolation. `browser-network-policy.e2e.ts` exercises real Chromium enforcement,
asserts that opaque previews cannot leak requests, verifies ordinary cross-origin
styles and redirects in the visible browser, and captures both an existing tab
and a freshly opened tab.
