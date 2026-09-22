# First-class classifier providers

Status: implemented for validation, 2026-09-22. Base: `883ff2e11` (`origin/main`).

Risk: medium. This adds credential-backed network calls and a local scorer process through an
explicit classifier surface. Existing host approval, secret storage, and main-frame IPC contracts
apply. Copse's active safety classifiers and chat model selection are outside this change.

Implementation is split between HTTP/schema, SemIf/eval, and settings agents, with the lead owning
storage, IPC, integration, and the single PR. See [usage instructions](../classifier-providers.md).

## Outcome and scope

Users can configure classifier providers in Copse, securely save their keys, connect to local
servers, and invoke the configured models from explicit test calls and evals. Adding a compatible
provider should require configuration; adding a different protocol should require a small adapter.

This phase does not choose a classifier for any existing Copse feature. It does not change shell
permissions, safety classification, model routing, titles, or the agent loop. Classifier-only
models stay out of chat and role-model pickers. Local support means connecting to an already-running
server or explicitly invoking an installed SemIf scorer. Installing Python, downloading weights,
training, and managing persistent inference servers are separate work.

## Findings and provider identities

The existing reusable pieces are:

- `src/main/services/storage/settings.ts`: provider-slug credentials, OS keyring storage with legacy Electron `safeStorage` reads,
  stored-key/environment resolution, deletion, and explicit consent when encryption is unavailable.
  Keys live in `settings.json`, separately from ordinary app data in `config.json`.
- `src/main/services/providers/extra-providers-store.ts`: preset/custom configuration patterns,
  stable IDs, and save-time host approval.
- `packages/llm/src/credential-url.ts` and `provider-host-policy.ts`: credential URL validation
  and provider destination restrictions.
- `src/main/ipc/register-handlers.ts`, the generated API protocol manifest, and `src/preload/`: validated
  settings access that exposes key status, never stored secret values.
- `src/renderer/views/setup/custom-providers-section.ts`: existing provider settings conventions.
- `packages/llm/`: Electron-independent provider code usable by Node evals.

`LLMProvider` currently exposes a streaming chat/tool contract. `ExtraProvider` assumes Chat
Completions or Responses. Neither is an appropriate classifier contract. The existing
`model-classifier.ts` recommends chat models, and `safety-classifier.ts` prompts a chat model;
neither needs changing for this phase.

Primary API references checked on 2026-09-22:

| Provider                 | Verified integration                                                                                                                                                                                               | Initial treatment                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| TypeSafe / Jev           | Bearer-authenticated `POST https://api.typesafe.ai/v1/systemone`; `TYPESAFE_API_KEY`; typed questions and answers. [Official quick start](https://docs.typesafe.ai/introduction/quickstart)                        | Built-in hosted preset.                                                                     |
| Kev                      | Local `/v1/systemone`, `/v1/models`, and no built-in authentication. [Maintainer README](https://github.com/jaredpalmer/kev#api)                                                                                   | Confirmed local preset.                                                                     |
| SemIf                    | Local `semif-score` CLI consumes and produces JSONL. [Maintainer README](https://github.com/TheoLeeCJ/SemIf#quick-start) and [CLI source](https://github.com/TheoLeeCJ/SemIf/blob/master/src/semif_phase1/cli.py). | Confirmed local process adapter; do not assume a System One HTTP endpoint.                  |
| Featherless / Simple Jev | Production `/v1/classifier` with bearer auth; a separate local implementation is available. Limits and response semantics differ. [Official API documentation](https://simple-jev.featherless.ai/docs)             | Concrete second protocol profile; support through a preset and compatible custom endpoints. |

The user confirmed the intended names are Kev and SemIf. No references to Jev, Kev, SemIf, or
OpenJev (SemIf's former name), or a dedicated eval harness for them, were found in the tracked
checkout. Locate the user's existing evals before attempting a migration. The shared contract
and runner can proceed independently of that integration detail.

## Architecture decisions

### 1. A separate classifier contract within the existing provider package

Add `packages/llm/src/classifiers/` rather than a new workspace package or a rewrite of the chat
provider registry. Its public surface consists of provider/model metadata, validated request/result
types, and asynchronous `classify(profile, request, options)` and `classifyBatch(profile, requests, options)` functions.
The library accepts credentials and transport dependencies from its host; it imports no Electron
settings or renderer code.

The initial contract supports a text/JSON state and a map of named questions:

- `choice`: named options with optional descriptions; returns the chosen option and probabilities.
- `boolean`: a proposition with optional true/false descriptions; returns a probability, mapping
  to the upstream `noul` primitive. It does not invent a true/false threshold.
- `score`: ordered rubric levels; returns the provider's numeric score, distribution, and scale.

Results preserve question IDs, reported confidence when present, requested and returned model IDs,
provider identity, elapsed time, request ID and usage when available. Missing usage or confidence
remains absent. Provider confidence, probability, and calibrated accuracy are distinct concepts;
the adapter must not replace one with another. Preserve question/option ordering for reproducible
evals. Validate returned answer types, option membership, ranges, and distribution keys against the
request. Malformed or incomplete responses produce explicit errors rather than guessed answers.

The usage documentation records supported question types, limits, and score/confidence semantics.
Adapters validate provider-specific limits before sending. Model IDs are configured manually; model
discovery is deferred.
Unsupported capabilities fail explicitly; they do not silently fall back to chat or another model.
TypeSafe documents confidence separately from probability in its
[confidence guide](https://docs.typesafe.ai/confidence); evals should retain both.

SemIf's initial capabilities are choice and boolean-as-two-options. Its native input uses one
`id`, `state`, `question`, and ordered `options` array per row, with 2–16 options in the checked
[validator](https://github.com/TheoLeeCJ/SemIf/blob/master/src/semif_phase1/core.py).
Map a named-question request to rows and reassemble by ID; use the option ID as the description
when the caller supplies no description. Preserve the probabilities and derive the selected choice
by argmax with stable tie handling; boolean returns the true option's probability. Mark these
mappings as adapter-derived. Native score support is absent from this contract, so reject score
requests for SemIf initially instead of silently synthesizing a rating. Preserve its revision,
prompt hash/version, readout and probability-status metadata; its
[direct scorer](https://github.com/TheoLeeCJ/SemIf/blob/master/src/semif_phase1/direct.py)
does not return a calibrated confidence field.

### 2. Presets and connection profiles

Persist a versioned `classifierProviders` setting with stable profile ID, display name, adapter ID,
model ID, timeout, and a discriminated connection configuration: HTTP base URL/authentication,
or SemIf executable path/backend/model revision and validated runtime options. Secrets are never
fields in this record.
Support multiple profiles for the same vendor or server so evals can compare deployments.

Start with no configured profiles; offer TypeSafe, Kev, and SemIf as Add templates. Add Featherless's documented classifier
profile as a second supported HTTP API variant. Provide “Custom classifier” for endpoints compatible
with an implemented adapter; arbitrary REST APIs still need an adapter and fixtures. Do not assume
every provider implements `/models`, accepts the same number of options, or is authenticated simply
because a public discovery request succeeds. Manual model IDs always work.

Derive credential IDs from profile IDs in a reserved `classifier-` namespace, with validation that
fits the existing credential-slug limit. Reuse the existing secure store, key status, and deletion
semantics. Built-in hosted profiles have documented environment fallbacks, starting with
`TYPESAFE_API_KEY`; precedence matches current Copse behavior: saved key, then environment.
Custom profiles use saved keys in the app and an explicitly named environment variable in headless
eval configuration. Keyless profiles send no fabricated authorization header. Deleting a custom
or template-derived profile deletes its own saved key. There is no separate preset reset operation.

Keep this registry independent of `extraProviders` and `settings:availableProviders`, which feed
chat model availability. Reuse small credential/UI helpers where useful without broad refactoring.

### 3. Transport and main-process service

Use a shared JSON HTTP transport and a separate SemIf process transport, both behind the same
classifier contract. Each adapter owns request encoding and response validation.
Apply existing credential URL and host policies on every request, including tests and model
discovery, for HTTP connections. Add verified built-in classifier hosts explicitly to the shared allowlist. Custom
remote hosts use the existing approval flow; headless calls require prior approval or an explicit
endpoint in their run configuration. Preserve the current restrictions on non-loopback private
hosts; LAN discovery is outside this phase.

Remote credential-bearing endpoints require HTTPS; loopback HTTP follows existing policy. Reject
redirects so credentials and eval inputs cannot move to a different destination. Support bounded
response sizes, deadlines, cancellation, and distinct authentication, connectivity, rate-limit,
invalid-request, unsupported-capability, and invalid-response errors. Default to one attempt so
eval timings and costs remain interpretable; any later retries must be bounded and reported.

For SemIf, spawn the configured executable directly with structured arguments and no shell. Use
private temporary JSONL input/output paths, clean them up, bound output, and terminate the child on
cancellation or deadline. Invoke once per eval batch so model loading is not repeated for each row;
default to direct scoring, with other supported modes explicitly selected and recorded. Distinguish
process/model startup time from reported scoring time. Require an installed runtime and cached/local
weights, using the runtime's offline settings so a Test action cannot initiate a download. Pass only
the runtime environment it needs, excluding unrelated provider keys. Validate executable and model
configuration at save/invoke boundaries; this is a specific scorer integration, not a generic shell
command field. Process failures and missing runtimes are explicit errors. Tests use a fake scorer
executable, so the app's normal test suite gains no Python/GPU requirement.

Add `src/main/services/classifiers/` for profile resolution and invocation using saved credentials.
Honor existing secret-redaction behavior for submitted content without altering question/option
identifiers. Do not log keys, authorization headers, or entire eval inputs by default. Return only
safe configuration, key status, and typed results across validated main-frame IPC. Profile saves
use dedicated validated handlers, not an unrestricted `settings:set` escape hatch.

Saving configuration performs no inference. An explicit “Test classifier” action submits a small
fixed sample through the same invocation path used by evals. Distinguish “key saved,” “server
reachable,” and “test call succeeded”; a provider without a free auth endpoint must not incur paid
requests while typing or merely opening Settings.

### 4. Settings experience

Add a Classifiers section to Settings, using existing tokens and form conventions. Show configured
profiles, local/remote destination, adapter, model, optional password field, saved/encrypted key
status, and Add/Edit/Remove/Test actions. Explain that these connections are available for evals
and explicit calls. Show only relevant fields; model discovery is optional and failure does not
erase saved manual IDs. Existing privacy badges may be reused, with “unknown” for unverified
provider policies. SemIf shows executable, backend, model and revision fields instead of a URL or
API key. An explicit test reports whether the installed scorer and cached model can run.

The Test result shows the returned answer and timing with a readable error state. A full classifier
playground, thresholds UI, model comparison dashboard, or per-feature default selector is deferred.

### 5. Calling classifiers from evals

Provide one importable Node API and a `pnpm run eval:classifier` JSON/JSONL runner. Both use the same
adapters and validation as the application. The runner supports two explicit modes:

1. **Headless:** non-secret run configuration plus credentials from named environment variables.
   Works in CI or on remote eval machines without Electron or an OS keyring.
2. **Saved Copse profile:** select a profile ID and use a small Electron entry point that imports
   `app-init.ts` before settings, waits for `app.whenReady()`, resolves the saved key, performs calls
   in that process, and returns only results over stdio. It creates no window and does not export
   the decrypted key to a Node child. Keep it separate from normal app/agent startup and read-only
   with respect to app settings and usage stores, avoiding concurrent-process store writes.

Feed fixture IDs, state, questions, and optional expected answers into the runner. Write JSONL
results with adapter version, requested/returned model, fixture/config hash, results, elapsed time,
usage, runtime/backend identity where relevant, and explicit failures. Unknown cost stays unknown. Never silently substitute a mock model
or another provider. Support pinned model versions and record server checkpoint metadata when
available; a `latest` alias alone is not a reproducible identity. Add bounded concurrency and
cancellation, defaulting to one request at a time.

Migrate one existing classifier eval once its location is supplied. If those evals are external,
document an import/CLI example that consumes the same fixtures instead of inventing a competing
benchmark. A deterministic smoke fixture proves invocation; choosing winners or switching Copse's
active classifiers remains separate work.

## Implementation work packets for simpler agents

Freeze the contract and file ownership before parallel work. Each packet should land with its
focused tests; shared-file edits belong to the named integration owner.

| Packet                             | Owner scope                                                                                             | Depends on                                        | Completion evidence                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A. Contract and provider inventory | One lead: protocol matrix, types, fixtures, registry shape under `packages/llm/src/classifiers/`        | Names confirmed; pin source versions and fixtures | Reviewed request/result examples, HTTP/process configurations and explicit capabilities; no chat API changes.                 |
| B. HTTP transport and adapters     | One agent: HTTP transport, TypeSafe/System One, Kev profile, Featherless profile                        | A                                                 | Fixture-backed contract tests, cancellation/timeout/error coverage, destination and secret handling.                          |
| B2. SemIf adapter                  | One agent: JSONL mapping, process runner, runtime metadata and fake-scorer fixtures                     | A                                                 | Choice/boolean mapping, score rejection, batched process execution, cleanup/cancellation and no key leakage.                  |
| C. Storage and main service        | One agent: profiles, key resolution, main invocation; owns settings, host-policy, IPC and preload edits | A; B's interface                                  | Save/reload/replace/delete, env fallback, isolated credentials, main-frame validation, no secret readback.                    |
| D. Settings                        | One agent: classifier section and component tests; owns settings-dialog wiring and visual spec          | C's IPC contract, then B/C for integration        | Add a local profile and a keyed remote profile, explicit test success/failure, focused screenshot eval.                       |
| E. Eval runner                     | One agent: Node runner, saved-profile Electron entry, fixtures and eval documentation                   | A/B/B2/C                                          | Same fixture works through environment and saved-profile modes, including SemIf; failures are recorded and keys stay private. |
| F. Integration and review          | Lead: shared-file conflict resolution, regression verification, usage instructions                      | B/B2/C/D/E                                        | Required checks and screenshots pass; chat and active-classifier behavior remains unchanged.                                  |

Suggested sequence: A first; B and C in parallel; D and E after the shared contracts are stable;
schedule B2 into the next free slot before E integration; F last. The execution uses three implementation agents plus the integration lead. Do not assign
multiple agents simultaneous ownership of `register-handlers.ts`, preload files, settings schemas,
or `package.json`. Agents share the frozen contract; the lead integrates and validates their changes.

## Acceptance and validation

The feature is complete when a user can save a hosted key, restart Copse, make an explicit typed
call, and run an eval with that saved profile; configure and call Kev and an installed SemIf scorer;
and add another compatible endpoint without changing application code. The same models must also be
callable from a Node-only eval using environment credentials. Declined plaintext storage leaves
no key behind. No classifier appears as a chat model or changes an existing permission decision.

Use unit tests for adapters, profile validation, credential precedence, malformed responses,
timeouts/cancellation, process lifecycle, and result serialization. Use component tests for form state and actions.
Add a focused WebdriverIO Electron spec covering actual profile/key IPC and an explicit test call
against a local fixture server, saving screenshots for inspection. Tests must use isolated app
data and deterministic responses, without requiring a paid key or running model.

For UI work, follow `.cursor/skills/screenshot-validate/SKILL.md`, `docs/ui-taste.md`, and
`docs/testing-strategy.md`. Prefer remote e2e where configured, retaining local coverage for the
OS credential path. Run `pnpm run check`, `pnpm run build`, and the required Electron e2e checks;
include the new spec in the test oracle. Before any commit run the repository's prescribed checks;
before a PR rebase onto `origin/main`. Live provider smoke calls are a separate opt-in validation,
not a CI dependency or evidence that a model is suitable for production policy.
