---
name: codebase-health-review
description: Coordinate area-by-area codebase reviews, prioritize concrete usability, reliability and performance problems, and optionally take selected fixes through independent PR validation. Use for broad review campaigns or multi-area remediation, not ordinary single-change review.
---

# Codebase health review

Produce an evidence-backed hit list of problems that hurt users. When fixes are requested, turn
the selected findings into small, independently reviewable changes. Optimize for confirmed user
impact and completed fixes, not the number of findings, agents, tests or PRs.

## Set the campaign boundary

Read `AGENTS.md` and the relevant architecture and testing docs. Record the requested areas,
user-facing outcomes and phase: **review**, **triage**, or **fix and validate**. A review request
authorizes investigation and reports; it does not by itself authorize implementation, publishing
PRs, readiness changes or merging. Carry forward authorization already given in the conversation.

Use an existing backlog or campaign record when available. In this repo,
`pnpm run backlog:snapshot` provides a shared read-only view; consult
[`docs/agent-development.md`](../../../docs/agent-development.md#task-brief-and-completion-evidence).
Keep a compact record of finding, area, severity, evidence, owner, status and PR/head when relevant.
The snapshot is not live authority for a mutation.

## Divide by ownership and failure boundaries

Map the actual codebase before assigning reviewers. Useful boundaries may include conversation
state, persistence, agent/tool execution, process cancellation, permissions, provider integration,
renderer interactions, plugins and validation infrastructure. Follow the architecture rather than
forcing this example list onto every repository.

Delegate independent areas when useful and permitted, within available capacity. For a small scope
or unavailable delegation, retain the same ownership boundaries in a single-reviewer report. Give
each reviewer:

- the area's entry points, dependencies and user journeys;
- the requested failure classes and relevant contracts;
- a read-only review scope and a concrete report format;
- responsibility to inspect adjacent boundaries and identify overlaps with other reviewers.

Prioritize data loss, cross-chat/project state leakage, cancellation and broken primary flows when
those are in scope. Also look for confusing or inaccessible UX, avoidable latency and unnecessary
core complexity. Do not require a quota of findings; a well-supported "no actionable finding" is valid.

Use one accountable owner per finding. Deduplicate a shared root cause across area reports instead
of opening competing fixes. Keep user-created chats distinct from internal subtasks. When a handoff
depends on an idle agent, use a follow-up operation that starts work; a notification alone may not.

## Require useful reports

Each area report should contain a short assessment and a ranked hit list. Each actionable item needs:

- **Impact and trigger:** what a user experiences and how they reach it.
- **Evidence:** exact code locations and the causal path, plus a reproduction, measured result or
  controlled interleaving where feasible. State what was observed versus inferred.
- **Priority and confidence:** severity, frequency/reach and uncertainty. Distinguish confirmed
  defects from investigation leads; do not present a suspicion as a reproduced failure.
- **Fix and validation:** the smallest plausible change, relevant ownership boundary and a focused
  regression test or visual/runtime evaluation that would establish the result.

Keep cosmetic preferences below reliability failures. A dramatic-looking diff or a large file is
not evidence of user harm. Have the coordinator challenge high-priority findings and reconcile
duplicates before dispatching implementation.

If plugin extraction is requested, report candidates separately from defects. Explain the optional
user journey, concrete core cost and proposed extension boundary. Identify dependencies and core
contracts that must remain supported. Infrequent use alone does not justify removing a feature,
and critical persistence, permission and cancellation guarantees must survive any extraction.
Recommend an extraction before performing it unless implementation is also authorized; follow the
repo's binding hooks/feature-pack plan where applicable.

## Dispatch the selected fixes

When the user requests implementation, read [Fixes and PR validation](references/remediation.md).
Select the highest-impact confirmed findings within the requested scope. Do not silently expand
the campaign to every lower-priority item in the reports.

Give each fix a bounded brief: finding/evidence, acceptance example, owner, affected contracts,
focused regression and intended PR boundary. Prefer one coherent defect per PR and isolated
branches/worktrees. Identify a shared prerequisite once and coordinate its owner; check whether
another PR or main already supplies it before copying the same infrastructure fix into every branch.

## Hand off the outcome

Report the prioritized findings and dispositions, area reports, completed fixes/PRs, exact validation
and remaining work. Distinguish review complete, implementation complete, required CI green,
visual review complete, ready for review and merged. State actual PR state and who merged it.
Keep unresolved findings visible; do not call unrelated implementation or a passing test a closure.

Do not merge without authorization. Do not turn advisory checks, unrelated backlog items or
metadata-only reruns into new mandatory acceptance criteria. Surface genuine blockers with the
next concrete action, while continuing independent authorized work.
