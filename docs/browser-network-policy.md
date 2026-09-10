# Browser network policy

The visible Browser pane (including MCP HTML/URL artefacts and chat links) and the
agent's browser tools enforce `webAllowedOrigins` at the Electron session request
boundary. This is the same allowlist used for web tools, including wildcard hosts
and ports. An explicitly empty network allowlist denies all network requests.
The old `browserAllowedOrigins` setting no longer grants separate network access.

Every HTTP(S) request, redirect target, embedded resource and WebSocket handshake
is checked. Private/link-local targets are denied. Requests without an owning
page, including background service-worker traffic, fail closed. Both the browser
and web approval settings must permit approval before a new origin can prompt.
A remembered navigation approval adds the origin to the network allowlist;
a one-time approval lasts for this app session and belongs only to its task.

Browser partitions and automation tab managers are scoped by project and task.
Interactive and agent browser profiles remain separate. Existing tabs keep their
original owner when the selected task changes; popup tabs inherit that owner.
Tab persistence, pop-outs and agent preview promotion preserve that scope too.

Local HTTP previews get an additive CSP in response headers. It allows resources
from the page's own origin, inline scripts/styles and embedded data/blob images,
but denies external origins, frames, workers, plugins and base URL changes.
Existing server CSPs still apply. A network approval does not relax this local
preview CSP: bundle assets locally and proxy required APIs through the dev server
under the user's normal network policy.

HTML artefacts prepend the same CSP before untrusted markup. Data URL documents
have no network access even if their HTML omits the CSP, including access to
allowlisted hosts and localhost. Direct browser navigation supports HTTP(S) only. Workspace file previews use
the existing static preview server, so relative files load from its loopback
origin under the same policy. This does not enable arbitrary file URL browsing;
file documents, if encountered, cannot make network requests.

Validation: `browser-network-policy.test.ts` covers the request matrix and additive
CSP; `browser-network-grants.test.ts` and the permission-gate tests cover task
isolation. `browser-network-policy.e2e.ts` exercises real Chromium enforcement,
asserts that blocked images/fetches never reach a second test origin, verifies
same-origin images and captures `browser-preview-network-policy.png`.
