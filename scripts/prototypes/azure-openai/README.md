# Azure OpenAI transport prototype

Task brief for issue #648. Initial base: `95dd2bd701472f40adb2a18d68d23d5d82817da7`.

Prove an Azure v1 Responses connection through Copse's existing SDK-backed
`ResponsesProvider` using an injected HTTP transport. Acceptance: endpoint and
deployment stay pinned; credentials renew between requests; fragmented text,
tool calls and tool results round-trip; cancellation stops work; usage survives;
authentication errors do not disclose credentials or silently choose another
account. A truncated stream must fail instead of reporting success.

Scope: an isolated, executable developer prototype under `scripts/prototypes/`.
No Settings fields, app routing, credential persistence, new dependencies, real
accounts, or network calls in the demo. Production identity integration and live
Azure smoke tests remain required. No UI changes or screenshot baselines apply.

Validation: focused transport tests and executable demo, test oracle, then the
full repository check because the prototype exercises authentication boundaries.

## Run offline

```sh
pnpm run prototype:azure
pnpm test -- scripts/prototypes/azure-openai/adapter.test.ts
```

The demo injects a synthetic HTTP response beneath the real OpenAI SDK and
Copse Responses adapter. It does not replace the SDK's stream parser. A first
turn requests a fixture `lookup` tool; the next turn sends that tool's result
using a renewed synthetic token. SSE bytes are split into eight-byte chunks,
including a boundary inside the two-byte UTF-8 character in `café`.
The report contains only counts, fixture text and booleans, never auth headers.
Tests additionally cover rejected endpoints, connection pinning, expired or
failed credentials, HTTP errors, bounded retries, cancellation and truncation.

## Connection contract

`createAzurePrototype` accepts a public Azure resource root (or `/openai/v1/`)
at `<resource>.openai.azure.com` or `<resource>.services.ai.azure.com`, a deployment
name and either an API key or an asynchronous Entra token source.
It returns the existing `LLMProvider` interface. The injected transport is
mandatory: there is no default network implementation or ambient credential
lookup. The demo and tests use synthetic credentials exclusively.

The token source is called before every HTTP attempt, including safe retries.
An eventual Azure identity SDK owns token caching and renewal. This prototype
checks expiry with a 30-second margin and fails closed if renewal did not return
a usable token. A 401 is terminal; it does not silently switch identity or repeat
the same rejected credential. Cancellation stops waiting even if the identity
SDK does not honor its signal. Credential resolution itself has no built-in
deadline; a future caller must provide the operation's abort/deadline signal.

Requests are restricted to the selected resource's `/openai/v1/responses`, send
the deployment as `model`, and set `store: false`. Redirects are disabled, and
unrelated OpenAI organization/project headers are stripped. SDK exceptions are
replaced by actionable status-based errors without retaining upstream bodies,
headers or causes. No server compaction, strict-tool, reasoning replay or pricing
capability is inferred from the deployment's opaque name.

This is a developer experiment, not a selectable app provider. All new connection
fields live under `scripts/prototypes/`; there is no test-only product setting.
The app's existing provider policy, storage, routing and UI are unchanged.

## Remaining before app integration

- Endpoints under `<resource>.cognitiveservices.azure.com` are outside this
  prototype's allowlist and need separate compatibility validation.
- Move the missing-terminal-response check into the shared `ResponsesProvider`
  before app integration. This prototype's wrapper supplies that guard because
  the shared provider currently requires completion only on its ChatGPT-plan route.
- Connect a supported Azure identity SDK to the token source and test the chosen
  tenant/login flow. The callback simulation does not prove Entra login or refresh.
- Add a supported connection/settings surface, persist only appropriate connection
  metadata, and route credentials through the existing host-side inference path.
- Bind approved endpoints, connection/account identity, deployment capabilities,
  usage attribution and pricing explicitly. The prototype reports deployment
  token usage but does not calculate Azure billing.
- Use an inference-aware connectivity check; listing models does not prove a
  deployment exists or that the identity can invoke it.
- Capture focused WebdriverIO screenshots when an app surface is added. This
  prototype does not change rendered UI and does not supply visual evidence.
- With an authorized account, smoke-test API key and intended Entra login,
  tools, refresh, cancellation, token usage, denied roles and wrong deployments
  from the packaged desktop and host-backed container path. Private endpoints,
  sovereign clouds and custom gateways need separate scope and evidence.

No real-account smoke test has run; issue #648 remains open.

## Protocol references

- [Azure v1 API and deployment names](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle)
- [Azure v1 authentication methods](https://learn.microsoft.com/en-us/azure/foundry/openai/latest)

The v1 contract uses the standard OpenAI client and supports bearer API-key or
Entra authentication. A production adapter should use these explicit v1 routes
rather than silently inferring legacy dated API behavior.
