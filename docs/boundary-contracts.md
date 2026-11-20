# Production-boundary contracts

A scheduled lane that exercises the real services Copse depends on, so a vendor-side change is
found by a run rather than by a user ([#1370](https://github.com/copse-dev/agent-pane/issues/1370)).
Ordinary pull-request CI stays on mocks and loopback fixtures and never depends on a third party.

- Workflow: [`.github/workflows/boundary-contracts.yml`](../.github/workflows/boundary-contracts.yml)
- Runner: [`scripts/boundary-contracts.mts`](../scripts/boundary-contracts.mts) (targets) and
  [`scripts/lib/boundary-contracts.mts`](../scripts/lib/boundary-contracts.mts) (classification,
  waivers, redaction, reports)
- Waivers: [`scripts/data/boundary-contract-waivers.json`](../scripts/data/boundary-contract-waivers.json)

The contracts go through product code wherever plain Node can load it. The LLM contracts stream
through `@copse/llm`'s own provider factories, with the same retry wrapper, SDK error classes and
abort handling the agent loop uses. The update-feed contract calls the app's
`fetchUpdateChangelog`. GitHub and npm are checked at the response shapes the product reads.

## Matrix

| Contract                       | Needs                         | Passes when                                                                                       |
| ------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `anthropic/generation`         | `CONTRACT_ANTHROPIC_API_KEY`  | `claude-haiku-4-5` streams text, a usage chunk with output tokens, and a done chunk               |
| `anthropic/invalid-key`        | same                          | a well-formed but rejected key fails with 401/403, and `isRetryableStreamError` says do not retry |
| `anthropic/unavailable-model`  | same                          | an unknown model id fails with 404, not retried                                                   |
| `anthropic/cancellation`       | same                          | aborting after the first chunk settles within 5 s as an error `isStreamAbortError` recognises     |
| `anthropic/recovery`           | same                          | the same provider instance serves a full request after a cancelled one                            |
| `openai/generation`            | `CONTRACT_OPENAI_API_KEY`     | as above, `gpt-5-nano` over the Responses API                                                     |
| `openai/invalid-key`           | same                          | as above                                                                                          |
| `openai/unavailable-model`     | same                          | 400 or 404, not retried                                                                           |
| `openai/cancellation`          | same                          | as above                                                                                          |
| `openai/recovery`              | same                          | as above                                                                                          |
| `openrouter/generation`        | `CONTRACT_OPENROUTER_API_KEY` | as above, `openai/gpt-5-nano` with the product's ZDR-only, no-training routing                    |
| `openrouter/invalid-key`       | same                          | as above                                                                                          |
| `openrouter/unavailable-model` | same                          | 400 or 404, not retried                                                                           |
| `openrouter/cancellation`      | same                          | as above                                                                                          |
| `openrouter/recovery`          | same                          | as above                                                                                          |
| `github/rest-read`             | `GITHUB_TOKEN` (job token)    | `GET /repos/{repo}` decodes and carries usable `x-ratelimit-*` headers                            |
| `github/graphql-read`          | same                          | the GraphQL endpoint answers a repository pull-request query in the expected shape                |
| `github/invalid-token`         | same                          | a rejected token answers 401, which the GitHub backend reports as signed out                      |
| `github/missing-resource`      | same                          | an unknown repository answers 404, not a server error                                             |
| `update-feed/changelog`        | none (token raises the limit) | `fetchUpdateChangelog` returns notes for the newest release; prerelease flags match channels      |
| `update-feed/beta-channel`     | none                          | the newest release's `<channel>-mac.yml` files parse, name its version, and match asset sizes     |
| `update-feed/stable-channel`   | none                          | the newest stable release's `latest-mac.yml` matches; skipped until a stable release exists       |
| `acp-adapters/npm-<agent>`     | none                          | each `KNOWN_ACP_AGENTS` `installPackage` is published, not deprecated, and installs `command`     |

`pnpm run contracts:boundary -- --list` prints the live matrix. A unit test fails if a contract in
code is missing from this table. Model ids can be overridden with the repository variables
`CONTRACT_ANTHROPIC_MODEL`, `CONTRACT_OPENAI_MODEL` and `CONTRACT_OPENROUTER_MODEL`.

The degraded cases the issue asks for map onto contracts as follows:

- **Degraded authentication:** the `invalid-key` and `invalid-token` contracts.
- **Rate limiting:** the `rate-limited` outcome, including GitHub's 403 with
  `x-ratelimit-remaining: 0`. A run cannot provoke a real 429 without spending quota, so that
  classification has unit coverage.
- **Timeout and cancellation:** `cancellation`, plus a 90 s deadline on every contract.
- **Unavailable capability:** `unavailable-model`, `missing-resource`, and the stable channel before
  a stable release exists.
- **Recovery:** `recovery`.

## Outcomes

| Outcome        | Meaning                                                                                                                                                                                          | Run result      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `pass`         | The contract held                                                                                                                                                                                | green           |
| `regression`   | The boundary answered and the product cannot handle what it said: an unexpected 4xx, a response that no longer decodes, a failed assertion. An invalid, expired or over-long waiver also counts. | **red**         |
| `outage`       | 5xx, 408, a connection failure, or no answer before the deadline                                                                                                                                 | green + warning |
| `rate-limited` | 429, or GitHub's 403 rate-limit shape                                                                                                                                                            | green + warning |
| `skipped`      | The target's secret is not configured, or the capability does not exist yet                                                                                                                      | green, listed   |
| `waived`       | A failure covered by a live waiver                                                                                                                                                               | green, listed   |

Outages do not fail the run on purpose. A lane that goes red whenever a vendor has a bad hour
trains everyone to ignore it. The step summary and the warning annotations still show each one.
Classify a recurring outage by hand. If it turns out to be a product problem, such as a request
the provider now rejects with a 5xx, fix it or waive it with an issue.

## Waivers

A waiver silences one failing contract (or `*` for a whole target) while a tracked issue is open:

```json
{
  "waivers": [
    {
      "target": "openrouter",
      "contract": "generation",
      "issue": "https://github.com/copse-dev/agent-pane/issues/1234",
      "reason": "Upstream ZDR endpoint for the contract model is withdrawn; switching models",
      "expires": "2026-11-20"
    }
  ]
}
```

Waivers expire automatically. On the first scheduled run after `expires`, the waiver itself is
reported as a regression. A waiver dated more than 60 days out, or one naming an unknown target or
contract, is also a regression, so no waiver can be permanent. When a waived contract passes, the
summary lists the waiver under "delete them". PR CI checks only that waivers name real contracts.
Expiry is enforced by the scheduled lane, so a date passing never turns an unrelated PR red.

## Secrets and redaction

- Keys come only from secrets of the `boundary-contracts` **environment**:
  `CONTRACT_ANTHROPIC_API_KEY`, `CONTRACT_OPENAI_API_KEY` and `CONTRACT_OPENROUTER_API_KEY`. Never
  store them as repository or organization secrets. Use dedicated, budget-capped keys and not
  personal or reviewer keys, so revoking one breaks nothing else. GitHub contracts use the job's own
  `contents: read` token.
- The environment's deployment branches are limited to `main` and `release` (Settings →
  Environments → `boundary-contracts` → Deployment branches and tags → Selected branches). This is
  the control that matters. `workflow_dispatch` runs the workflow file from whichever branch it is
  dispatched on, so a writer could otherwise dispatch a branch whose runner sends the keys
  elsewhere. The policy lives in repository settings, out of a branch's reach: a branch copy that
  keeps `environment:` is refused, and one that drops it gets no keys. The job's
  `if: github.ref == …` guard is defence in depth, so a stray dispatch shows up as a skip.
- Secrets are bound to the single run step. The dependency install, which runs package lifecycle
  scripts, never sees them. The checkout does not persist credentials.
- The workflow has no `pull_request` or `merge_group` trigger and runs only on hosted runners. Fork
  or queue candidate code never runs next to a key ([CI runner trust boundary](ci-runner-security.md)).
- Every string the runner emits passes through `createRedactor`: the console lines, step summary,
  annotations and JSON report. It strips each literal secret value first, because an upstream
  that echoes the key back is the realistic leak, and then every credential shape
  `redactSecrets` knows. This sits on top of Actions' own log masking. A unit test feeds a
  provider error that contains the key and checks the report.
- The contracts never print request bodies or response bodies. Details are statuses, token counts,
  versions and short reasons.

## When it runs

- **Daily** at 05:29 UTC.
- **Each release candidate:** every push to `release`, the same push from which
  [release-cut](../.github/workflows/release-cut.yml) tags a new version.
- **Manually** with `workflow_dispatch`. The optional `targets` input takes comma-separated
  target ids.

## Ownership and alerting

The release-readiness owner owns the lane, the same owner as
[product release evidence](product-release-evidence.md) (#1373). A failed scheduled run is the
alert: GitHub emails the user who last changed the workflow's schedule, and the run's summary
names each regressed contract. Whoever changes a provider adapter, the GitHub backend, the update
feed or the ACP catalog is expected to keep its contracts here current. Unit tests on the runner
catch most drift before it lands.

## Cost budget

Rejected calls (`invalid-key`, `unavailable-model`) are not billed. Each LLM target makes at most
three billable calls per run: two replies of a few tokens, and one stream cancelled after its
first chunk. At the catalog prices for Claude Haiku 4.5 ($1/$5 per MTok) and GPT-5 nano
($0.05/$0.40), a generous bound of 1k input and 2k output tokens per target per run is about
$0.011 for Anthropic and under $0.001 for OpenAI. That comes to well under **$1/month** for all
three providers at a daily cadence plus releases. Set a hard **$5/month** spend limit on each
contract key in the provider console. Hitting it shows up as `invalid-key` and `generation`
failures, not as a surprise bill.

## Safe manual reruns

Every contract is read-only or self-contained. It creates no issues, PRs, releases, files or
provider-side state, so rerunning is always safe:

- From Actions → Production-boundary contracts → **Run workflow**, optionally with
  `targets: update-feed,acp-adapters` to skip the keyed providers.
- Re-running a failed release-candidate run is safe. Its report replaces nothing: each attempt
  uploads its own `boundary-contracts-<run>-<attempt>` artifact.
- Locally: `pnpm run contracts:boundary -- --target update-feed --target acp-adapters`. A target
  whose secret is not exported is skipped. Never paste a contract key into a shared shell or a
  thread.

## Release evidence

At release cut, record the release-candidate run's URL, the `boundary-contracts.json` artifact
from it, and any live waivers in [`product-release-evidence.md`](product-release-evidence.md). The
run URL and its summary are immutable. The artifact is kept for 90 days, so copy the summary table
into the evidence entry if the decision needs to outlive that.

## Not covered yet

This is the first slice of #1370. Still to add:

- An ACP adapter **handshake** (Tier 1 `probe:acp`) against installed adapter binaries in CI. Today
  the lane checks only the npm packages auto-setup installs.
- MCP servers, SSH targets, OS secure storage, and signed packaged applications, all named in #1370.
