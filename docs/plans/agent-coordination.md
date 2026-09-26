# Agent coordination on likely edit collisions

Status: **runnable protocol prototype with an isolated, scripted Electron demo**.
Not enabled for ordinary or release app sessions.

Two independent tasks should be able to discover that they intend to change the
same file, exchange a short proposal, and divide the work. The motivating example
is a license collector task and a notices-staleness task agreeing to reuse the
collector and avoid competing edits to `THIRD_PARTY_NOTICES.md`.

The useful capability is **coordination within existing authority**. A peer can
offer information or a proposed division of work. It cannot authorize an action,
inherit approvals, take control of another task, or restart it. Agreement is not
proof that the proposed code is correct or that the collision is resolved on disk.

## Run the prototype

```sh
pnpm run prototype:coordination
pnpm run prototype:coordination -- --json
```

The demo uses two scripted participants, prints their exchange, and asserts the
final declared scopes no longer overlap. The JSON variant includes the broker's
ordered journal. It makes no model calls, changes no files, sends no network
traffic, and never reads or changes live task state. Its in-memory state is lost
on exit. Implementation: [`broker.mts`](../../scripts/prototypes/agent-coordination/broker.mts),
[`demo.mts`](../../scripts/prototypes/agent-coordination/demo.mts).

The contract tests live in
[`broker.test.ts`](../../scripts/prototypes/agent-coordination/broker.test.ts)
and are included in the normal `pnpm test` discovery. These tests exercise the
protocol and its refusal cases, not real model obedience or Electron integration.

### Electron demonstration

```sh
pnpm run build
pnpm run test:e2e:coordination
```

The focused spec starts two actual Copse task loops with a deterministic provider
fixture. The fixture chooses tool calls from actual results, while the normal
registry, permission gate, tool cards, and thread persistence execute the work.
It captures waiting and agreement screenshots, exports both traces, and copies
the isolated profile to `.tmp/coordination-demo/profile` for local viewing.
This tests the protocol and application wiring, not autonomous model judgment.

The adapter in `src/main/services/coordination-demo.ts` requires a development
build plus all three host flags: `COPSE_COORDINATION_DEMO=1`, `COPSE_E2E=1`, and
`COPSE_PANEL_MOCK_LLM=1`. Only the two exact scripted prompts create a run-bound
session; other tasks have no coordination capability. The release build guard
checks that the demo flag and fixture have been eliminated. No real provider is
used for the exchange, and there is no production consent bypass.

The demo's note tool waits up to 30 seconds for an explicit recipient read in
its existing run. This keeps the sender alive until delivery; it does not start
a model turn or inject a message. Stop cancels the wait and immediately revokes
the session. Tool results retain the peer's origin and untrusted/authority labels
in ordinary persisted task history; the broker journal remains in memory.

## Detect overlap before proposing communication

Start with an explainable rule instead of an LLM confidence score: **two current
write intentions for the same exact repository-relative file**. This is evidence
of a likely collision, not a calibrated probability. Reading the same files,
working in the same directory, or similar task titles does not open a channel.

| Observed relationship                                      | Result                                         |
| ---------------------------------------------------------- | ---------------------------------------------- |
| Same file, same physical checkout                          | Shared-checkout overwrite risk                 |
| Same file, different worktrees of the approved repository  | Possible merge conflict                        |
| Different files                                            | No channel                                     |
| Different disclosure scopes, including local-only vs cloud | No discovery or messages                       |
| Expired intent, stopped run, or replaced run               | Old channel revoked; unread notes become stale |

In the spike, agents declare up to 16 exact file paths with a two-minute lease.
An identical, still-live renewal preserves the channel. Releasing, replacing, or
renewing an expired intent invalidates it. Renewals do not reset message budgets.

For app integration, the host should derive evidence from validated mutation
proposals before applying them, and supplement it with explicit upcoming-write
intentions. Never read all other conversations to guess their plans. An intention
is an advisory claim, **not a lock or exclusive ownership**; lying or incomplete
claims can produce false positives or misses. Shell writes, renames, generated
outputs, file aliases, and related changes to different files need additional
coverage. Do not infer that "no overlap found" means a write is safe.

## Protocol and interaction

1. The **host** registers an opted-in run with its thread ID, fresh run ID,
   physical checkout ID, and approved disclosure scope. The agent receives only
   a bound port: `claim`, `inspect`, `send`, and `poll`.
2. A task declares upcoming writes. `inspect` returns the overlapping paths,
   peer task ID, risk category, and a broker-minted collision capability. It
   does not reveal the peer's other paths, prompt, history, or file contents.
3. Either participant may send a bounded plain-text note using that capability.
   A third task cannot use it, even if it knows the ID. There is no arbitrary
   thread-addressing, broadcast, file attachment, or execute-command field.
4. The recipient explicitly polls during its existing run. It receives a tool
   result stamped `untrusted-peer-context`, `authority: none`, and
   `autoDispatch: false`, with both run IDs and the shared paths. Text claiming
   to be a user approval remains text; it changes no host policy.
5. The recipient may reply, decline, adjust its intentions, or continue other
   work. No party has to wait indefinitely for acknowledgement. In the example,
   the collector task releases the notices file after reading the agreement.
6. Stop/end/revoke invalidates the bound port. Neither an old sender nor an old
   collision ID can reach a newer run. Stale notes are dropped on polling and
   recorded as such; the host journal retains the original exchange.

Proposed app presentation: a small, attributable "Overlapping work" tool card
with the paths and peer task link, followed by sent/received note records. Make
"Context from another agent — no permissions granted" explicit when expanding
a note. Preserve Stop, dismiss/mute, and the ordinary diff/approval UI. The current
Electron demo uses existing tool cards with three added human-readable tool labels;
the dedicated collision UI and mute controls are still proposed.

## Preserving Copse's guarantees

| Boundary                        | Prototype enforcement                                                                  | Required production integration                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Agent identity                  | Sender identity lives in a host-created closure, never model input                     | Bind to the existing run context; do not trust IPC/tool-supplied sender IDs                                                              |
| Project and provider disclosure | Exact host-issued scope match and opt-in required for both runs                        | Explicit consent for repository, participating tasks, and provider destinations; revoke on changes                                       |
| Local-only data                 | Separate scopes do not discover or send to each other                                  | Same Git remote or same repository is insufficient consent; apply recipient redaction/provider policy before its model call              |
| Permissions and sandbox         | Broker imports no executor, permission service, filesystem service, or scheduler       | Every resulting action still re-enters that recipient's registry, workspace guard, permission gate, hooks, diff queue, and recovery path |
| Untrusted content               | Fixed untrusted envelope; body cannot alter routing or authority                       | Keep peer origin in the transcript/provider framing; never promote it to system instructions or a new human request                      |
| Lifecycle                       | Fresh run identity, intent revision, lease expiry, host-only Stop                      | Revoke on Stop, completion, provider/scope changes, and restart; never reuse collision capabilities                                      |
| Model turns and spend           | Explicit polling only; zero automatic turns or interrupts                              | No background wake or send-now path; any future machine continuation must use the existing shared turn-tree ledger                       |
| Chatter and memory              | Four notes per sender run, 1,024 characters per note, eight unread notes per recipient | Retain bounds and show budget exhaustion; do not reset budget on reclaims or tool retries                                                |
| Inspection                      | Ordered, host-only journal with original note and sent/received/dropped records        | Persist on both thread spines before delivery; round-trip full saves and exports; show origin in UI                                      |

Peer provenance is **not** a prompt-injection defense on its own. A model may
follow malicious peer text, so preserving the recipient's enforced tool boundaries
is essential. A peer's "the user approved this" claim never counts as approval.
Likewise, a peer's permission to use a cloud provider cannot authorize disclosure
of a local-only task's text to that provider.

The prototype journal is inspectable in memory, not durable or tamper-evident. It
is capped at 2,048 records and the broker supports 32 run registrations per demo
instance, including stopped runs. It fails closed on capacity instead of silently
sending unrecorded notes. Stop still revokes even if recording the stop fails.

These are additive coordination constraints. They do not improve the underlying
[platform sandbox limitations](../threat-model.md) or make shell writes atomic.
No claim is made that agent agreement prevents races or merge conflicts. Preserve
the existing stale-content check in `diff-queue.ts` at apply time. That
read/compare/write sequence is not an atomic lock against concurrent writers.
Introducing reservations would require host-enforced atomicity through **all**
mutation paths, including shell writes. Isolated worktrees are the safer place to
evaluate the feature first.

## Integration seams and gates

The protocol lives under `scripts/prototypes/`; its dev-only Electron adapter lives
under `src/main/services/`. No production tools or settings are registered. Before
enabling coordination for real providers:

1. **Host-scoped experimental feature.** Default off. Add a feature pack using the
   existing registry, then bind the broker through the run context. Verify
   repository identity from the canonical Git common directory plus host identity;
   do not equate clones just because their remotes match. Obtain disclosure consent
   separately. Do not expose this host configuration through agent tools.
2. **Filesystem identity.** Use validated canonical workspace identities for
   existing files and nearest-existing-parent resolution for new files; cover
   case folding, symlinks, rename source/destination, and aliases. The spike's
   strict lexical path check is insufficient for these cases.
3. **Tool delivery first.** Native `coordination_check` / `coordination_note` tools
   can expose the prototype's narrow operations as ordinary bounded tool results.
   Runtime-validate tool arguments. Capture intents before mutations without
   bypassing existing gates. Do not add an async mid-turn injection channel.
4. **Queue semantics if notification is added.** Follow
   [hooks and feature packs decisions 4–6 and 16](hooks-and-feature-packs.md#decisions-log).
   Use the existing pending queue with a new explicit peer origin and
   `autoDispatch: false`; never masquerade as a human or hook. A plain enqueue
   auto-drains today. Neither a peer note nor its receipt should abort an active
   turn, reset its budget, or resume a stopped one. Automatic continuation is out
   of scope for this prototype.
5. **Durability and UI.** Add peer records to both spines with idempotent delivery
   IDs and full-save/export round-tripping. Test outbox recovery, crashes between
   append and delivery, and recipients that have changed run or scope. Then add
   focused Electron evals for collision, receipt, mute, and stopped states, with
   screenshots. No live rollout before those checks pass.
6. **Permission regression tests.** Run real registry tests proving that a peer
   message requesting an external shell command still asks for approval, a
   read-only recipient still cannot write, and source approvals never transfer.
   Exercise malicious notes and cross-provider disclosure attempts. The spike's
   envelope tests cannot establish these runtime guarantees by themselves.

Success for the next integrated experiment: two worktree tasks spot a shared
file, voluntarily split the work, retain a readable exchange, and incur no new
model turn or permission change solely because a peer contacted them. Measure
false alerts, missed conflicts, note volume, and additional tokens separately;
do not report negotiated agreements as proven conflict prevention.
