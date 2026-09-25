# Classifier providers and evals

Copse stores classifier connections separately from chat providers. Open **Settings → Classifiers**
to add a TypeSafe/Jev, Kev, SemIf, Featherless/Simple Jev, or compatible custom connection. Saving a
profile or its key makes no inference request. **Test** submits a small sample and displays the
answer and duration. These profiles are available for safety screening, explicit calls and evals;
they never appear as chat models or change model routing or the agent loop.

## Safety screening

**Settings → Classifiers → Safety screening** chooses what screens shell commands and terminal reads:
the Instruct / safety model (the default, set under Models) or one saved connection. Choosing makes
no inference call. The choice is stored with the profiles, so removing the chosen connection hands
screening back to the safety model. **Settings → Permissions → Check commands for danger** still
turns screening on or off for both.

The classifier answers one two-way choice question — `sandbox` / `external` for a command, `safe` /
`risky` for a terminal snapshot — with the same rules the safety model's prompt states. The
probability of the chosen option becomes the verdict's confidence, so the existing thresholds apply
unchanged: a `safe` terminal read needs at least 0.5, and strict mode's
`safetyExternalDenyThreshold` compares against the `external` probability. Each call has the safety
model's 8-second budget. A timeout, connection failure, missing key, removed connection, or
malformed answer yields no verdict, which asks the user; the lasting faults are recorded once per
thread in the decision log. A hosted classifier receives the command or terminal text, with known
saved keys redacted. A SemIf profile starts its scorer for every call and will usually miss the
budget; prefer a running server. See [`shell-permissions.md`](shell-permissions.md) for where
screening can and cannot affect a decision.

Remote HTTP profiles use an HTTPS endpoint and, when configured, a bearer key. Loopback HTTP is
supported for local servers. Copse requests approval for new remote hosts. Keys use Copse's existing
secret store and encryption/consent behavior. A saved key takes precedence over a named environment
variable. Classifier keys have their own `classifier-<profile-id>` storage namespace. Keyless profiles
send no authorization header. Removing a profile removes its own saved key.
Changing an existing profile's HTTP destination, protocol, or authentication mode clears its saved
key before applying the change. Save a replacement key or select a named environment variable for
the new destination. Classifier credential IDs are reserved from custom chat-provider IDs.

Saved Copse profiles can use a hosted preset's variable (`TYPESAFE_API_KEY`, `FEATHERLESS_API_KEY`)
only with that preset's own endpoint; the rule is derived from `CLASSIFIER_PRESETS`. Custom saved profiles use a
dedicated `COPSE_CLASSIFIER_*` environment variable or a saved key. Other app/cloud credentials
cannot be selected as classifier tokens. The explicit headless `--config` mode can name any
environment variable supplied by the caller.

## Run an eval

Use Node 24+ and the repository's installed pnpm dependencies. Fixtures are a JSON array or JSONL
rows containing `id`, `state`, `questions`, and optional `expected`. Start with
[`benchmarks/classifiers/smoke.jsonl`](../benchmarks/classifiers/smoke.jsonl). `expected` is preserved
for your evaluation code; this runner measures invocation and records results, without inventing
thresholds or grading provider quality.

Use a running Kev instance:

```sh
pnpm run eval:classifier --config benchmarks/classifiers/kev.json \
  --input benchmarks/classifiers/smoke.jsonl --output /tmp/kev-results.jsonl
```

Edit the example's endpoint/model to match your server. For an authenticated hosted call, set the
key in the environment variable named by the configuration, then run:

```sh
pnpm run eval:classifier --config benchmarks/classifiers/typesafe.json \
  --input benchmarks/classifiers/smoke.jsonl --output /tmp/jev-results.jsonl
```

The TypeSafe example reads `TYPESAFE_API_KEY`. Never put keys in configuration or fixture files;
inline key fields are rejected. A headless configuration explicitly selects the endpoint and has
no access to Copse's saved credentials. Pin a provider model revision where supported: mutable
aliases such as `jev-latest` do not identify a reproducible checkpoint.

To use a connection and key already saved in Copse:

```sh
pnpm run eval:classifier --profile typesafe \
  --input benchmarks/classifiers/smoke.jsonl --output /tmp/saved-profile-results.jsonl
```

Use the profile ID shown in Settings. This mode starts a separate Electron process without a
window, waits for the OS credential service, and decrypts the key within that process. It creates
no agent or conversation and does not rewrite settings or migrate secrets. The profile must
already exist in the current Copse data directory; `COPSE_DIR` or `COPSE_PANEL_USER_DATA` can select
another existing profile. Open Copse normally first if legacy app data still needs migration.
A locked or unavailable OS keyring produces a credential error.
Each saved-profile eval snapshots its configuration, credentials, redaction secrets, and host
approvals for the run. A new run observes updated settings. Stop an active eval to revoke access
immediately; its separate process does not observe settings changes made in the running app.

Omit `--output` to write JSONL to stdout. `--concurrency 1..16` bounds HTTP concurrency and defaults
to one request at a time. SemIf always receives the entire fixture batch in one process. Interrupt
the command to cancel active calls; remaining fixtures receive explicit cancellation records.
The exit code is `0` when every call succeeds, `1` when any fixture fails, and `2` for invalid
arguments, configuration, files, or runner startup.

Each output row preserves the fixture ID/expected values, fixture and nonsecret configuration
SHA-256 hashes, wall-clock duration, typed result or explicit error, adapter version, requested and
returned model identities, provider timing/usage when reported, and available checkpoint metadata.
Missing usage/confidence/cost stays absent. No retries or model substitutions occur. Error output
omits provider response bodies and process logs, which can contain submitted content.

## SemIf runtime

Install [SemIf](https://github.com/TheoLeeCJ/SemIf#quick-start) separately, prepare its Python/backend
runtime, and cache the model before invoking Copse. Configure the installed `semif-score` executable
or its absolute path, the model, and its revision. Remote model IDs require a pinned 40-character
commit according to SemIf; local models use an explicit manifest/revision identifier. For
`llamacpp`, also supply the local `gguf` file. The example
[`semif.json`](../benchmarks/classifiers/semif.json) uses placeholders you must replace.

Copse invokes the scorer directly, with private temporary input/output JSONL files and offline
Hugging Face/Transformers settings. It passes only runtime-related environment variables, excludes
provider keys, bounds JSONL files, and cleans up after completion or cancellation. Scorer progress
logs are discarded without a size limit, so verbose model loading cannot fail an otherwise valid
run. Runtime cache and library settings such as `XDG_CACHE_HOME`, `PYTHONPATH`, and
`LD_LIBRARY_PATH` are preserved. Normal parent-process exit terminates the scorer process group
on macOS/Linux and removes its private files. It does not install dependencies, download weights,
or manage an inference server.

For SemIf, the configured timeout is a budget per native question row. The default batch deadline
is that timeout multiplied by the number of rows, capped at 2,147,483,647 ms (the runtime timer
limit). An API call's explicit `timeoutMs` override is a hard whole-batch deadline. Results record
the effective `deadlineMs` alongside startup/scoring timing; cancellation can stop a long batch.

The [native CLI](https://github.com/TheoLeeCJ/SemIf/blob/master/src/semif_phase1/cli.py) supports
`direct`, `serial`, and `shared` modes exposed here; `direct` is the default. Each named question
becomes one native row with 2–16 ordered options. Choice uses a stable argmax; boolean maps the
`true` option's probability. Results mark these mappings `derived`; native probabilities are not
calibrated confidence. Score questions fail explicitly. Per-question native model, prompt,
readout, token, and timing metadata remains in `metadata.rows`. `processElapsedMs` includes startup
and model loading; native scoring times remain separate.

## Import the shared API

Node callers can use the same Electron-independent package API as the app:

```ts
import { classify, classifyBatch } from '@copse/llm/classifiers/index.ts'

const apiKey = process.env.TYPESAFE_API_KEY
const result = await classify(
  profile,
  {
    state: 'The bicycle is red.',
    questions: {
      color: {
        type: 'choice',
        instructions: 'What color is the bicycle?',
        options: { red: null, blue: null },
      },
    },
  },
  { ...(apiKey ? { apiKey } : {}), signal: abortController.signal },
)

// Batch SemIf requests together to load weights once.
const results = await classifyBatch(profile, requests, { signal: abortController.signal })
```

Credentials are an optional call dependency, never part of `ClassifierProfile`. Choice responses preserve
option probabilities and separately reported confidence. Boolean responses preserve a probability
without choosing a threshold. Score responses preserve the provider's score, distribution, and
ordered rubric. Unsupported capabilities and malformed responses throw `ClassifierError`.

Use the existing external eval suite's fixtures with this runner, or import `runClassifierEval`
from `scripts/classifier-eval.ts` to retain its hashes and failure records. The included smoke
fixture validates transport and output only; it does not replace an application benchmark or
justify switching an active Copse classifier.
