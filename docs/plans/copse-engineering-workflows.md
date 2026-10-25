# Copse engineering workflows

Status: Initial implementation, 22 October 2026. The optional pstack bundle change
and experimental native guidance are implemented here. Complete upstream workflow
compatibility and comparative real-model evaluation remain rollout requirements.

Copse should provide a compact engineering process built around observable outcomes.
Users should also be able to install upstream pstack as an ordinary third-party
plugin and use its workflows. Copse owns its engineering guidance and general plugin
compatibility; Lauren Tan's pstack remains independently authored and versioned.

## Product boundaries

Remove pstack from the bundled skill distribution and retain its marketplace entry.
Do not rename the upstream package, silently rewrite its instruction bodies, or
require it for normal Copse work. A managed installation should retain the upstream
revision, authorship and license, with any host adaptation visible in diagnostics.

Copse engineering is a first-party plugin using the existing plugin lifecycle and
instruction assembly. Its initial release is experimental and disabled by default.
The three workflows below describe behavior; they do not require three new tools,
three separate skill files, or a new workflow engine.

Users enable the native guidance through its plugin setting and request work in
ordinary language. Explicit workflow selection can be offered through the existing
invocation surface once there is a demonstrated need. Avoid adding a model call
solely to classify every request into a workflow.

The guidance contributes once per thread — on the turn with no prior messages —
rather than on every turn, using `TurnStartPayload.firstTurn` (hooks-and-feature-packs
decision 20). A long thread that already received the block keeps following it from
prior context; re-injecting identical guidance on every later turn only adds load
without changing behavior. A fire site that has not computed thread history leaves
`firstTurn` absent, which the hook treats as "unknown" and still injects.

When a user explicitly invokes an alternative engineering workflow such as pstack,
Copse engineering guidance abstains for that invocation. Existing permission checks,
project instructions, read-only mode, spend approval, cancellation and continuation
limits still apply. An alternative workflow does not disable independent product
features such as review; their existing lifecycle and invocation rules remain.

## Principles and observable behavior

| Principle                     | Behavior it should produce                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Establish success             | Identify an observable result before substantial work; use existing task requirements when they are sufficient.                                          |
| Investigate to a decision     | Trace the relevant behavior and constraints. Stop broad exploration when there is enough evidence to make the next useful change or answer the question. |
| Keep changes coherent         | Prefer a small understandable change. Remove dead weight where relevant, while preserving compatibility that active users and callers need.              |
| Put correctness at boundaries | Parse external data, represent meaningful states in types and make retried operations converge where appropriate.                                        |
| Verify the result             | Exercise the changed behavior and inspect the actual artifact. Distinguish observed success, partial evidence and unresolved gaps.                       |
| Own delegated work            | Give workers bounded deliverables, protect concurrent writes and inspect their output before integration.                                                |
| Scale effort to the task      | Spend planning, model capability, testing and parallelism on concrete uncertainty or consequence.                                                        |
| Preserve useful knowledge     | Record consequential decisions and resume state. Replace recurring corrections with structural checks where possible.                                    |

User experience and maintainability belong in acceptance criteria. These principles
are decision guidance, not a required set of labels in the user's final answer.

Do not import pstack's mandatory architecture panels, universal multi-model steps,
personal prose rules, branded agent identity or requirement to cite a principle for
every decision. Do not treat an instruction to keep working as authorization for
external messages, new spend or unlimited continuation.

## Native workflows

### Investigate

1. Identify the question and the evidence needed to answer it.
2. Trace the relevant system and check competing explanations where uncertainty matters.
3. Run the smallest useful experiment when observation can settle the question.
4. Return the supported conclusion, evidence and remaining uncertainty.

Investigation is read-only unless the user authorizes an experiment that changes
state. Temporary probes follow normal permissions. A diagnosis, explanation or
recommendation can complete the task without a product patch.

### Change

1. Establish the intended behavior and an observable acceptance check.
2. Inspect the relevant code, constraints and existing work.
3. Make a coherent increment and inspect the resulting diff or artifact.
4. Verify the behavior through the lowest useful test tier and required project gates.
5. Report the outcome, evidence and material gaps.

A bug fix adds reproduction or equivalent evidence of the defect before the fix.
A migration adds sequencing and explicit compatibility checks. A visible change
adds the project's required visual evidence. A small mechanical edit does not
automatically require new unit tests, a design document or a reviewer panel.

### Review

1. Establish the artifact, intended behavior and review scope.
2. Use the existing Copse Reviewer where its contract fits.
3. Investigate consequential findings and challenge unsupported claims.
4. Return actionable findings with evidence, or state that none were established.

Review does not authorize fixing every finding. Extra reviewers or independent
model families are optional when their expected benefit justifies the cost.
Repeated samples from one model must not be described as cross-model review.

### Techniques within a workflow

Profiling, test-first fixes, competing prototypes, parallel exploration, isolated
implementation workers, decision logs and session handoffs are techniques rather
than separate mandatory playbooks. Select one to resolve an identified uncertainty,
reduce measured work or preserve meaningful state. Planning should be short enough
to keep current; a todo list is useful for multi-step work, not a prerequisite for
answering a simple question.

## Runtime responsibilities

The host enforces permissions, workspace containment, worker ownership, budgets,
cancellation, dependency access and plugin enablement. Guidance helps the agent
choose investigations, implementations and checks. A prompt cannot establish a
runtime guarantee, and a successful tool call cannot establish task correctness.

Use the existing [plugin layer](../plugins.md),
[hooks and feature pack contracts](hooks-and-feature-packs.md),
[model roles](model-roles-and-defaults.md),
[Reviewer](copse-reviewer.md), todos, thread history and artifact facilities.
Preserve the single continuation budget and disable semantics. Native and ACP
instruction assembly must select guidance from the same source and the actual
offered capabilities; do not maintain diverging copies of the workflow prose.

Start with a self-contained core instruction block. Specialist skills can be
composed through the bounded dependency mechanism when it lands. Do not create a
second persisted plan, audit log, scheduler or review pipeline for this plugin.
Use existing state and evidence references until a concrete missing operation is
demonstrated.

## Optional upstream pstack compatibility

Installation success means more than discovering SKILL.md files. Test an exact,
unmodified upstream revision through the normal managed install path, including
supporting files, agent definitions and dependencies on other plugins. Package
normalization can translate a supported manifest envelope, while retaining original
source content and provenance. It must not discard components and call the whole
workflow compatible.

| Upstream expectation                              | Copse compatibility requirement                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Nested skills and manual-only leaves              | Bounded dependency authorization, identity, deduplication and supporting-file reads.                                               |
| Skills inside subagents and external executors    | Explicit child and ACP access with separate attributable allowances.                                                               |
| Task-style workers and the packaged agent wrapper | Supported agent discovery, clear task lifecycle, cancellation and writable isolation where requested.                              |
| Role models and reasoning settings                | Available route selection, explicit configuration and observable fallback; no blind dispatch of Cursor-only identifiers.           |
| Cursor model configuration rules                  | A supported configuration adapter or equivalent upstream-supported configuration path; setup must actually affect subsequent runs. |
| Cursor transcript paths                           | A supported history-access adapter with Copse's project scope and consent rules.                                                   |
| Built-in skills and loop commands                 | A real supported equivalent or an upstream portable path for authoring, PR monitoring and autonomous wakes.                        |
| Referenced files and optional tools               | Complete package retention and precise diagnostics that distinguish examples from runtime dependencies.                            |

Adapters must preserve the relevant semantics and existing containment. Tool-name
substitution alone is not sufficient when lifetime, authorization or isolation
differs. Use general compatibility interfaces rather than pstack-specific branches
in the agent loop. Where the upstream format cannot express a portable dependency,
support a documented host adapter or propose a portable upstream change; do not
patch an installed instruction body behind the user's back.

The five infrastructure tasks are prerequisites, not proof that the entire
unmodified plugin works. Model configuration, history access and missing built-ins
need explicit integration coverage. Unsupported requirements stay visible with
their reason; diagnostics are an interim state, not the final compatibility target.

Compatibility claims identify the plugin revision, executor, relevant capabilities
and tested workflows. A one-model setup should run single-agent work; if a workflow
requires model diversity, report its absence rather than inventing a second family.

## Removing the bundled copy

1. Make bundle selection explicit so a later sync cannot reintroduce pstack.
2. Regenerate the snapshot and metadata through the sync path; retain the marketplace
   listing and general Cursor compatibility support.
3. Remove the pstack-specific default-off warning and bundled-row fixtures. Add a
   focused visual test for the absent bundled row and the available install entry.
4. Preserve independently installed pstack packages and their enabled state. Do not
   automatically install a replacement or transfer a bundled flag into install consent.
5. For profiles that enabled the bundled copy, offer the ordinary reviewed install
   flow. An inactive legacy override must not hide an independently installed plugin.
6. Preserve historical skill/tool rendering and references. Removing a live package
   must not rewrite prior conversations.

Removing the bundle does not wait for every pstack workflow to pass. The catalogue
must accurately show the supported scope while compatibility work continues.

## Acceptance examples

| Request or action                | Observable acceptance                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Explain a subsystem              | Investigates the relevant path, returns evidence and stops without an unsolicited patch.                             |
| Fix a rendering defect           | Establishes the defect, changes relevant code, runs a focused DOM check and produces visual evidence.                |
| Make a mechanical edit           | Completes the edit with appropriate verification and no automatic architecture panel or delegation.                  |
| Implement a bounded feature      | Names the behavior and acceptance check, makes a coherent change and reports what the checks establish.              |
| Review changes                   | Uses the existing review path, validates consequential findings and preserves the requested scope.                   |
| Invoke installed pstack          | Loads the unmodified installed workflow; native engineering steering abstains and normal host enforcement continues. |
| Disable either plugin            | Stops its new guidance and capabilities while leaving historical conversations readable.                             |
| Remove bundled pstack on upgrade | Keeps independently installed copies intact and offers enabled bundled users a reviewed installation.                |

## Implementation sequence and evaluation

The initial implementation removes bundled pstack, preserves its optional install
path, and adds self-contained experimental guidance through the existing plugin
layer, with executor and disable/precedence checks. Shared infrastructure lands
independently with its own validation before specialist skill composition is added.
Complete optional pstack compatibility against its real upstream requirements
independently of native workflow evaluation.

Compare native guidance enabled and disabled on matched tasks and the same model,
repository state, instructions and tool availability. Include an investigation, a
bug fix, a visible change and a small feature. Repeat across a strong model, a
smaller local model and a supported ACP executor, recording actual route identities.
Mock-provider tests establish plumbing; real-agent runs establish behavior.

Measure task correctness, regressions, unsupported completion claims, unnecessary
questions and delegation, cost, elapsed time and loaded context. Record failures
and run-to-run variance. Do not enable the native guidance by default until there
is evidence it improves outcomes without disproportionate cost or ceremony. A
single successful run does not establish all-model compatibility.

## Related infrastructure tasks

- Fix nested skill composition: 01a15e9d-596a-7f43-8256-0b45ac52c4f4.
- Support skills in child agents and ACP: 01a15e9d-6188-7600-a5f0-d31995212154.
- Parallel delegation and isolation: 01a15e9d-6ca8-7a61-9c48-1fec22624839.
- Resolve models for workflow roles: 01a15e9d-76e0-7fa1-92d4-6603e194930d.
- Diagnose workflow capabilities and dependencies: 01a15e9d-81cd-7622-8ef8-bf0b09fb84e0.

These tasks own runtime primitives. This proposal owns engineering behavior,
packaging, precedence, migration and the integration acceptance criteria. Existing
hook decisions remain binding; any later implementation that changes them must
update their owning decisions log in the same PR.

## Provenance

The design considers ideas from Lauren Tan's pstack and existing Copse practices.
Upstream pstack remains available from
[cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack).
Retain applicable upstream copyright and license notices wherever upstream material
is distributed. Copse's native product presentation describes its own behavior.
