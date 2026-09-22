# Current product release evidence

Evidence reconciliation: **20 September 2026**, source baseline
`0a7a0967002da98b6055dc9f87544e91c8ad501b`. This records observed readiness; it is not a new
security review, release waiver, or authorization to publish. Tracking owner:
[#1373](https://github.com/copse-dev/agent-pane/issues/1373), assigned to Jonathan Kingston.

Runtime/CI follow-up: **22 September 2026**, reviewed against `fe9531b17`. The cancellation
gate [#2722](https://github.com/copse-dev/agent-pane/pull/2722) and runtime reinstatement
[#2731](https://github.com/copse-dev/agent-pane/pull/2731) have merged. The subsequent
[scheduled full run](https://github.com/copse-dev/agent-pane/actions/runs/35601257564) at
`16f1e9e67` passed all eight Electron shards. The published-channel and GA-blocker snapshot
below retains its original reconciliation date; this follow-up grants no release acceptance.

## Published channel

The public repository lists [beta.8](https://github.com/copse-dev/copse-releases/releases/tag/v0.1.0-beta.8)
(29 August 2026) and [beta.7](https://github.com/copse-dev/copse-releases/releases/tag/v0.1.0-beta.7).
Both are prereleases. No stable release appears in the public release list at this review.
The [support policy](../SUPPORT.md) accepts reports on the latest public beta for best-effort triage.
Existence of the artifacts does not by itself prove anonymous install, every upgrade route, or GA readiness.

## Open GA blockers at reconciliation

| Tracker                                                      | Remaining evidence or outcome                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| [#802](https://github.com/copse-dev/agent-pane/issues/802)   | Stable/public distribution and channel-update acceptance           |
| [#2478](https://github.com/copse-dev/agent-pane/issues/2478) | Correct Claude ACP authentication/billing path                     |
| [#2507](https://github.com/copse-dev/agent-pane/issues/2507) | Approval UI belongs to the window that initiated the action        |
| [#2520](https://github.com/copse-dev/agent-pane/issues/2520) | Cancelled/superseded validation cannot satisfy merge authorization |

This list came from the live open `ga-blocker` query. Requery before a candidate decision; do not
infer that every open roadmap item is a GA blocker or that an issue's historical description is a
fresh reproduction.

## Acceptance still to reconcile

| Area                      | Existing evidence                                                                                                    | Missing candidate evidence / owner                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security                  | [Ledger](security-review-ga.md) reviewed through 28 August at `a413b3de`; recorded owner decisions remain historical | Review relevant changes through the actual candidate and refresh disposition; GA sign-off remains pending                                                                                               |
| Packaged artifacts        | Public beta.7/beta.8; separate signing and publishing workflows                                                      | Bind source run, checksums, install/update results, and owner decision to the next candidate; [#802](https://github.com/copse-dev/agent-pane/issues/802)                                                |
| Runtime approval coverage | Three reinstated Electron suites; successful post-merge full CI run linked above                                     | Refresh evidence for the release candidate; historical runner cause remains unproven. [#1680](https://github.com/copse-dev/agent-pane/issues/1680), [exclusion inventory](../tests/e2e/exclusions.json) |
| Persistence and recovery  | Store tests and [recovery instructions](recovery.md)                                                                 | Aged-profile first/second boot and restore rehearsal; [#994](https://github.com/copse-dev/agent-pane/issues/994)                                                                                        |
| Production integrations   | Mock/loopback coverage and adapter probes                                                                            | Candidate-relevant real-service contracts; [#1370](https://github.com/copse-dev/agent-pane/issues/1370), [#832](https://github.com/copse-dev/agent-pane/issues/832)                                     |
| Agent quality             | Existing benchmark/evaluation harnesses                                                                              | Accepted representative results through the shipped agent path; [#1371](https://github.com/copse-dev/agent-pane/issues/1371)                                                                            |
| Accessibility             | Focused component and visual tests                                                                                   | Release acceptance across core keyboard/screen-reader journeys; [#1369](https://github.com/copse-dev/agent-pane/issues/1369)                                                                            |

## Before the next release decision

Record the candidate SHA/channel, immutable validation and artifact links, current blocker
dispositions, dated security review, and explicit owner decision here. Every exception needs an
owner, rationale, scope, and expiry; no new exception is accepted by this reconciliation.
Keep historical records under `docs/releases/` unchanged. The machine-enforced candidate manifest
is later roadmap R07, not implemented by this document.
