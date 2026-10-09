# Classifier providers and evals

Copse stores classifier connections separately from chat providers. Open **Settings → Classifiers**
to add a Liquid/d1, TypeSafe/Jev, Kev, SemIf, Featherless/Simple Jev, or compatible custom connection. Saving a
profile or its key makes no inference request. **Test** submits a small sample and displays the
answer and duration. These profiles are available for safety screening, background questions, the
`classify_text` tool and
evals; they never appear as chat models. With **Match task**, the background
classifier assesses the first ask’s reasoning demand before Copse picks the primary model.
This assessment has a five-second budget and respects cancellation. An unavailable or
unusable classifier falls back to Small tasks, its chat-model backup, then the task
heuristic. Later asks keep the selected model.

## Safety screening

**Settings → Classifiers → Safety screening** chooses what screens shell commands and terminal reads:
the Instruct / safety model (the default, set under Models) or one saved HTTP connection. SemIf is
not offered: it starts its scorer for every call, which cannot fit the budget, and its token limit
could cut a snapshot the verdict must cover in full. Choosing makes no inference call. The choice
is its own `safetyScreeningClassifier` setting, so builds that predate it still read the profiles;
a choice naming a removed connection reads as none, and removing the chosen connection clears it.
**Settings → Permissions → Check commands for danger** still turns screening on or off for both.

The classifier answers one two-way choice question — `sandbox` / `external` for a command, `safe` /
`risky` for a terminal snapshot — with the same rules the safety model's prompt states. Verdicts are
read from the returned probabilities, never from the provider's `choice`:

- A terminal snapshot is shared without asking only when P(`safe`) is at least 0.80. Anything less
  is flagged and the user is asked. (The chat path's 0.5 floor is on a model's self-reported
  confidence; on a two-way distribution the chosen side always clears 0.5.)
- A command's scope is the likelier side, with a tie reading as `external`. Its probability is the
  confidence strict mode compares with `safetyExternalDenyThreshold`.

The chosen connection is also asked the escalation-review **tier question**, word for word
(`read` … `ask`, see `benchmarks/escalation-review/rubric.md`), as a second opinion. It never
authorizes anything:

- **Guarded YOLO:** when the harm gate would auto-run a command without a sandbox around it, a
  P(`ask`) of at least 0.5 turns that into the harm gate's one-time confirmation. A missing, slow
  or failing connection leaves the harm gate's decision as it was. Contained commands are not
  asked. On the command test set, Winnow-12B at this threshold would have caught 54 of the 56
  `ask` commands the harm gate let through before its rules were fixed. It prompts on about 1.7%
  of the real commands the harm gate allows.
- **Standard mode (shadow):** when a shell command is about to prompt, the question is asked in the
  background and a `tier-shadow` decision records whether P(`read` or `local-write`) ≥ 0.95 and a
  harm-gate allow would have auto-approved it at local-write. The prompt never waits and nothing
  changes. The record holds a SHA-256 of the command, never its text.

Each call has the safety model's 8-second budget, and a connection that keeps missing it is skipped
for a while, like a slow safety model. A timeout, connection failure, missing key, removed
connection, or malformed answer yields no verdict, which asks the user; lasting faults are recorded
once per thread in the decision log. A hosted classifier receives the command or terminal text,
with known saved keys redacted. See [`shell-permissions.md`](shell-permissions.md) for where
screening can and cannot affect a decision.

Remote HTTP profiles use an HTTPS endpoint and, when configured, a bearer key. Loopback HTTP is
supported for local servers. Copse requests approval for new remote hosts. Keys use Copse's existing
secret store and encryption/consent behavior. A saved key takes precedence over a named environment
variable. Classifier keys have their own `classifier-<profile-id>` storage namespace. Keyless profiles
send no authorization header. Removing a profile removes its own saved key.
Changing an existing profile's HTTP destination, protocol, or authentication mode clears its saved
key before applying the change. Save a replacement key or select a named environment variable for
the new destination. Classifier credential IDs are reserved from custom chat-provider IDs.

Saved Copse profiles can use a hosted preset's variable (`LIQUID_API_KEY`, `TYPESAFE_API_KEY`, `FEATHERLESS_API_KEY`)
only with that preset's own endpoint; the rule is derived from `CLASSIFIER_PRESETS`. Custom saved profiles use a
dedicated `COPSE_CLASSIFIER_*` environment variable or a saved key. Other app/cloud credentials
cannot be selected as classifier tokens. The explicit headless `--config` mode can name any
environment variable supplied by the caller.

## Background questions

**Settings → Classifiers → Background questions** chooses what answers the fixed-choice
judgements Copse makes on its own account. The default is the small-tasks model. Any saved
connection can be chosen, SemIf included. The choice is its own `backgroundClassifier` setting. A
choice naming a removed connection reads as none, and removing the chosen connection clears it.
Choosing makes no inference call. It is asked:

| Question                        | When                                                | Classifier request                                                                                                       | If it fails                                                                                                        |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Roadmap complexity and category | A roadmap prompt is saved                           | One `choice` question on the prompt; the connection's own timeout                                                        | Small-tasks model, then the chat model (see below)                                                                 |
| Issue coverage                  | The issue-import picker checks open issues          | One request per issue, one `none` / `partial` / `likely` question per roadmap item; 30 s per call and overall            | The small-tasks model, asked about every pair at once                                                              |
| Follow-up suggestions           | A turn ends and a bubble slot is still free         | One request on the exchange, one yes/no question per preset; 15 s                                                        | The small-tasks model's pick                                                                                       |
| Fit check                       | The pane's fit check on an item with a pinned issue | One `unlikely` / `partial` / `likely` question on the issue and prompt; 30 s                                             | The small-tasks model, asked at the same time, gives the reasoning; its verdict is used when no classifier answers |
| Roadmap review                  | Bulk and deep resolution reviews                    | One `open` / `partial` / `likely` / `resolved` question on the item, its issues and commit history; 45 s bulk, 60 s deep | As for fit check                                                                                                   |

A hosted classifier receives that text — roadmap prompts and notes, pinned, linked and imported
issues, the commit history a review reads, and **each finished turn's user message, assistant reply
and tool names** — with known saved keys redacted.

Fit check and roadmap review return a verdict and the model's reasoning. The classifier and the
small-tasks model are asked at the same time: the classifier's verdict wins when it answers, and
the model's bullets are shown beside it. When the classifier answers and the model fails or answers
off-format, the verdict stands without reasoning. When no classifier answers, both behave exactly
as before, errors included. Verdicts are listed least hopeful first, so a tie goes to `unlikely` or
`open`: a `resolved` verdict invites marking the item done.

Coverage verdicts are read from the probabilities with ties going to `none`, because a `likely`
match disables importing the issue. Each issue keeps its strongest match, the likelier one on a
tie. Follow-ups offer the presets with P(`true`) of at least 0.7, likeliest first, at most two;
none above the bar is an answer, not a failure. Neither falls back to the chat model: follow-ups
run after every turn, and coverage keeps the model it used before.

The roadmap labels share one question definition (`BackgroundChoiceQuestion` in
`src/main/services/classifiers/background-classification.ts`) and are asked in this order:

1. The chosen connection, as one `choice` question. The verdict is the likeliest offered option
   read from the probabilities, never the provider's `choice`. A tie goes to the earlier option,
   so options are listed in the order a tie should break (`low` before `medium`, `feature` before
   `project`).
2. When no connection is chosen, or it fails for any reason (removed, no key, timeout, malformed
   answer), the same question rendered as a one-word prompt for the small-tasks model. The rendered
   prompt matches, word for word, the one these features used before.
3. The chat model, only when the small-tasks call itself fails (a stopped server, an unloaded
   model, a timeout). A model that answers without an offered word gives no verdict, and no
   further model is asked: these labels are optional, and an off-format small model must not
   spend the chat model on every save.

Only an answer from a classifier carries probabilities, so a caller can apply a threshold only
to that. When nothing answers, the item is left without a badge, as before. Tokens a classifier
reports are recorded as `classifier` usage, attributed to the connection and model that answered (see
[Usage](#usage)); tokens the small-tasks or chat model spend stay `small-tasks` usage.

Safety screening does not use this path: it has its own time budget, and a failed screening
classifier asks the user rather than falling back to a model.

To compare a classifier connection with a small-tasks model on these questions, run
`pnpm run eval:background-questions`. It asks both of them labelled cases through the product's own
requests, prompts and parsers; see
[`benchmarks/background-questions/README.md`](../benchmarks/background-questions/README.md).

## The `classify_text` tool

The model can ask a saved classifier a typed question about some text. The tool takes a classifier
id, the `text`, a `type` of `choice` (2–16 distinct `options`) or `boolean`, and the `question`. It
returns one small JSON object: the classifier id, the returned model, elapsed milliseconds, and for
`choice` the likeliest option with every option's probability, or for `boolean` the probability of
`true`. The verdict is read from the probabilities, never from the provider's `choice`; a tie goes
to the option listed first. Nothing else the provider returned (metadata, request id, raw body) is
passed on. `text` over 20,000 characters is refused rather than cut, since a verdict on a prefix
misleads. Score questions are not offered: SemIf cannot answer them.

- **Offered only when a classifier is saved.** The tool is always registered but withheld per turn
  until a connection exists, as `video_frames` waits for a video, so a model is never shown a tool
  that can only fail and the schema costs no context before then. Once offered, its description
  names the configured ids. Saving a connection from Settings or the one-click installer needs no
  restart.
- **Egress follows the connection.** A connection that leaves the machine (any non-loopback HTTP
  endpoint) asks before every call, showing the text that will be sent; a loopback server or a SemIf
  scorer runs without a prompt. **Settings → Permissions → Tools** can set `classify_text` to
  _Always allow_, _Ask_ or _Block_, and an explicit choice wins either way. Whatever the prompt
  says, the call still goes through the classifier service, which re-checks host approval
  (`assertApprovedProviderHost`) and redacts known saved keys from remote text, exactly as for
  screening and background questions. A host that is not approved fails before anything is sent. The
  tool is not available in read-only agent mode.
- **Not a chat model.** Nothing here adds a classifier to a model picker or role-model list.
- **Usage and context.** Each call is recorded as `classifier` usage in the thread's project. Its
  schema counts under _Tools_ in the context wheel while offered, and its result counts under
  _Conversation_ like any other tool result.

## Usage

Classifier calls have their own usage source, `classifier`, written by the `classify_text` tool,
background questions, safety screening through a classifier, and the **Test** button. An event
records the model the provider returned, the connection's label as `provider`, and the tokens the
provider reported; a call that reports none records nothing, so a missing figure never reads as
zero. **Settings → Usage** lists them in a _Classifiers_ table for the day, month and 90-day windows:
one row per connection and model with calls, input and output tokens. They are not chat-model
usage: they appear in neither the cloud nor the local table, add nothing to the cost headline, and
never raise the "unpriced cloud usage" warning. All time is built from saved threads, which carry no
classifier usage, so it shows an explanation instead. Classifier tokens are not part of the context
wheel's thread usage either, since they are not that conversation's model tokens; they are in the
ledger, attributed to the thread, and in Settings → Usage.

Before this change, background and safety-screening classifier tokens were recorded as `small-tasks`
and `safety-classifier` usage under the classifier's model name, which appeared as an unpriced cloud
model; existing ledger entries keep their old source for the 90 days they are retained.

## Liquid decision API

Choose **Liquid / d1** in **Settings → Classifiers**, add the connection and save a Liquid API key
from [Liquid's console](https://console.liquid.ai), or launch Copse with `LIQUID_API_KEY` set.
The preset uses model `d1:free` and base URL `https://api.liquid.ai/decisions/v1`; the System One
adapter posts to `/systemone` beneath that URL. Both fields remain editable.

This uses [Liquid's native decision API](https://docs.liquid.ai/lfm/models/decision-models):
choice questions preserve the option probabilities and confidence, boolean questions map to `noul`,
and score questions preserve the numeric score, distribution and ordered rubric. The preset is not
chosen for safety screening or background questions automatically.

For an explicit headless smoke run, set `LIQUID_API_KEY` and use:

```sh
pnpm run eval:classifier --config benchmarks/classifiers/liquid.json \
  --input benchmarks/classifiers/smoke.jsonl --output /tmp/liquid-results.jsonl
```

This sends the fixture contents to Liquid. The profile enables evals; it does not establish d1's
quality on Copse tasks. `d1:free` is a provider alias, not a pinned model revision.

## Self-hosted systemone servers

Several open classifiers serve TypeSafe's `POST /v1/systemone` format, so each is one profile
with `protocol: "systemone"` and a `baseUrl` ending in `/v1`. Start the server, then run an eval
with its example profile. Model names and ports below are the projects' documented defaults
(checked 2026-09-25); adjust the profile if you start a server differently.

| Classifier    | Start the server                                                                                                                                                               | Example profile                                          | Notes                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kev           | `uv sync --extra serve`, then `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009`                                                                  | [`kev.json`](../benchmarks/classifiers/kev.json)         | Pass `--port 8009`; the code defaults to 8008. Binds 127.0.0.1. Verified 2026-09-25 on MLX (M1 Max): batches concurrent requests.                                                                                             |
| Winnow-12B    | `python3 scripts/serve.py` in EldanRing/winnow-inference                                                                                                                       | [`winnow.json`](../benchmarks/classifiers/winnow.json)   | Port 8091; 2–64 options. llama.cpp with Metal or CUDA.                                                                                                                                                                        |
| reflex 4B     | `uv sync --no-sources`, then `uv run --no-sync reflex-serve --stable --device mps --dtype float16 --port 8008` on a Mac                                                        | [`reflex.json`](../benchmarks/classifiers/reflex.json)   | Up to 26 options. Use `main`: the `stable` tag's code has no MPS path, and `--stable` on `main` reads the same configuration. Verified 2026-09-25.                                                                            |
| decider-4b    | `DECIDER_MODEL=Mapika/decider-4b DECIDER_DEVICE=mps uvicorn decider.serve:app --host 127.0.0.1 --port 8000` after `pip install "decider-ai[serve,metal]" "transformers>=5.17"` | [`decider.json`](../benchmarks/classifiers/decider.json) | Verified 2026-09-25 (tag `v2`, M1 Max, MPS float16): warm calls 0.7–1.2 s, every field the hosted API sends. `scripts/serve.sh` binds `0.0.0.0` with no authentication; bind `127.0.0.1` as shown.                            |
| metask-jev-4b | `python serve.py --port 8000 --model wayfind/metask-jev-4b-policy-mix` with `inference/` on `PYTHONPATH`                                                                       | [`metask.json`](../benchmarks/classifiers/metask.json)   | Omits `model` and `choice` (derived). `serve.py` hardcodes `0.0.0.0` with no authentication; change `app.run` to `127.0.0.1`. Send one request at a time on MPS: concurrent requests crashed the server. Verified 2026-09-25. |

Kev and Winnow can also be set up and started from a persistent cache at pinned revisions:

```bash
COPSE_CLASSIFIER_CACHE=/Volumes/Big/copse-classifier-cache pnpm run classifier:serve -- kev
COPSE_CLASSIFIER_CACHE=/Volumes/Big/copse-classifier-cache pnpm run classifier:serve -- winnow
```

**Settings → Classifiers** does the same from the app (see below for what it checks and how it fails). Opening it probes the loopback ports of the
servers below (a TCP connect, no request) and lists each as not installed, installed, or already
running; a running one gets **Add connection**, which saves the preset profile. **Download and run**
asks first, naming the size, source repository and required tools, then sets the server up in the
same cache at the same pinned revision, starts it on loopback, and saves its connection when it
accepts connections. It needs `git` plus `uv` (Kev) or `python3` (Winnow) on `PATH`, and the button
stays disabled and names the missing tool otherwise. Copse stops servers it started when it quits and
leaves ones started elsewhere alone; **Cancel** stops an install or load in progress. Nothing is
downloaded or started until you confirm, and the connection is not chosen for safety screening
or background questions automatically. A hosted preset whose provider key (`TYPESAFE_API_KEY`, `FEATHERLESS_API_KEY`) is
already in the environment is offered as **Set up**; the key's value is never shown or copied.

**Download and run** in detail:

- **Detection** only probes the loopback port (a TCP connect, no request) and reads a marker file;
  each server reads _Not installed_, _Installed_, _Running_ or _Detected running_ (someone else's).
  The button is disabled and names `git`, `uv` or `python3` when it is missing.
- **Before anything downloads:** the dialog names size, source and tools; declining runs nothing.
  Confirming first checks the port is free and the cache's volume has about 1.25× the download
  free, and stops with a message naming `COPSE_CLASSIFIER_CACHE` otherwise. A server already set up
  skips the disk check.
- **Failures** show on the row, with the failing command's last output line, and leave it ready to
  retry with nothing half-saved: _offline_ ("Could not reach the network…"), _out of disk space_
  (also mid-setup), a _pinned commit that cannot be fetched_ (setup code never runs at an unverified
  revision), a _port already in use_, and a missing tool. `GIT_TERMINAL_PROMPT=0` stops a clone
  waiting on credentials nobody can see. **Cancel** ends an install without an error.
- **Stop** stops a server Copse started. **Uninstall** (offered only for a stopped, installed
  server, after a confirmation) deletes that server's checkout, environment and model files from the
  cache, plus Kev's Hugging Face weights; the shared uv package cache and the saved connection
  stay, and it refuses while the server runs or the port is in use.

Validation: `local-classifier-install.test.ts` runs the real manager and cache preparation with fake
`git` and `python3` executables on `PATH` (`tests/helpers/fake-classifier-tools.ts`) and a real HTTP
"server"; `settings-classifiers-install.e2e.ts` drives the same flow through the Electron app.
Neither downloads anything. No real Kev or Winnow download has been run from an agent session: the
sandbox could not reach the Kev repository or Hugging Face (2026-10-07), so real-weights behaviour
(model load time, `--run` argument handling, memory) is verified only by the earlier manual runs
above.

The first run clones the server, installs it and downloads its weights (Kev about 8 GB, Winnow
about 12.5 GB text-only). Every later run reuses the cache and downloads nothing. The checkout,
virtual environment or native build, uv package cache (`UV_CACHE_DIR`), Hugging Face cache
(`HF_HOME`) and model files all live under `COPSE_CLASSIFIER_CACHE`, which defaults to
`~/.copse/cache/classifiers` (or `$COPSE_DIR/cache/classifiers`). Point it at a large volume when
the internal disk is short. `--setup-only` prepares the cache without starting the server.

JevK5 and Jobe also serve `/v1/systemone`, but their servers are CUDA-only. Hopper answers one
question per request and its weights are for non-commercial use. djev serves `/v1/request` rather
than `/v1/systemone` and needs a B200-class GPU. None of these has a preset.

Self-hosted servers often omit fields the hosted API always sends. The adapter derives them rather
than rejecting the answer, and lists each one in the result's `metadata.derivedFields`:

- a missing top-level `model` is reported as the requested model;
- a missing `choice` is the likeliest option, the first offered on a tie (the answer also carries
  `derived: true`);
- a missing `score` is the distribution's expected level, and a missing `legend` is skipped.

Fields that are present are still validated in full, and the distribution must still cover exactly
the offered options.

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

## Local GLiNER2.5-Decide

`benchmarks/classifiers/gliner-decide/server.py` serves Fastino's GLiNER2.5-Decide encoder over the
`systemone` protocol on loopback; `benchmarks/classifiers/gliner-decide.json` points
`eval:classifier` at it. Zero-shot it did not separate shell-scope or escalation-tier answers; the
setup and measurements are in that directory's README.

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
