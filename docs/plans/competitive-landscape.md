# Competitive landscape

Status: **Reference.** Not a plan and nothing to implement. A snapshot of seven products
next to Copse, compiled 27 July 2026, supporting the category section of
[`user-control-surface-gaps.md`](user-control-surface-gaps.md).

## Read the confidence column first

| Product     | Vendor         | What it is                                                                                    | Source    |
| ----------- | -------------- | --------------------------------------------------------------------------------------------- | --------- |
| Copse       | ours           | Electron desktop app. Local-first, per-command approval, OS-level sandbox, no account.        | read      |
| Piebald     | Piebald LLC    | Desktop and web. Positions on configurability — every knob exposed, per-chat and per-profile. | primary   |
| Qoder       | Alibaba        | Desktop IDE, Windows and macOS. Quest Mode for delegated work, auto-generated Repo Wiki.      | secondary |
| Trae        | ByteDance      | Desktop IDE. SOLO mode scaffolds a whole project from one description.                        | secondary |
| Antigravity | Google         | Agent-first platform. Mission-control view over many agents; artifacts as reviewable objects. | secondary |
| Zed         | Zed Industries | Rust editor, open source. Co-authored the Agent Client Protocol; hosts external agents.       | secondary |
| Devin       | Cognition      | Cloud autonomous engineer. No editor. Metered in compute units.                               | secondary |
| Span        | Span.app       | Not a coding agent. Engineering analytics — delivery metrics and AI-authorship detection.     | secondary |

- **primary** — the vendor's own pricing page, captured as a PDF.
- **secondary** — review sites and third-party write-ups, which are frequently stale on
  exactly the things a comparison cares about. Treat every figure as indicative.
- **read** — our own source, read rather than run.

Three of these are not the same product as Copse, which matters when reading the matrix.
Devin has no desktop editor. Span is not a coding tool. Zed is an editor that hosts other
people's agents rather than shipping its own.

**Absent from this review** and worth noting so it is not mistaken for complete: Cursor,
Claude Code, GitHub Copilot, Windsurf, JetBrains. Several of those we already integrate
with over ACP rather than compete with directly.

## Table stakes

Capabilities present in four or more of the seven. This is the entry fee, not a
differentiator: a product missing several reads as unfinished regardless of what else it
does well. `?` means the sources did not say — those cells are numerous on purpose.

| Capability                              | Copse   | Piebald | Qoder   | Trae | Antigrav | Zed | Devin   | Span |
| --------------------------------------- | ------- | ------- | ------- | ---- | -------- | --- | ------- | ---- |
| Chat, editor and terminal in one app    | yes     | yes     | yes     | yes  | yes      | yes | no      | n/a  |
| MCP servers                             | yes     | yes     | yes     | ?    | ?        | yes | ?       | n/a  |
| Bring your own model, several providers | yes     | yes     | yes     | yes  | ?        | yes | no      | n/a  |
| Reuse an existing subscription login    | partial | yes     | ?       | ?    | ?        | yes | no      | n/a  |
| Subagents                               | yes     | yes     | yes     | ?    | yes      | ?   | yes     | n/a  |
| Web search and fetch                    | yes     | yes     | ?       | ?    | yes      | ?   | yes     | n/a  |
| Image and vision input                  | yes     | yes     | ?       | ?    | yes      | ?   | ?       | n/a  |
| Persistent project instructions         | yes     | yes     | yes     | ?    | ?        | yes | yes     | n/a  |
| Plan before executing                   | partial | yes     | yes     | yes  | yes      | ?   | yes     | n/a  |
| Approval before a write or command      | yes     | yes     | ?       | ?    | yes      | yes | partial | n/a  |
| Consumption visible to the user         | partial | yes     | yes     | yes  | ?        | ?   | yes     | n/a  |
| Windows, macOS and Linux                | **no**  | yes     | partial | yes  | yes      | yes | yes     | yes  |
| Delegate a task and walk away           | **no**  | ?       | yes     | yes  | yes      | ?   | yes     | n/a  |
| Told when a run needs you               | **no**  | yes     | ?       | ?    | yes      | ?   | yes     | n/a  |
| Named reusable configurations           | **no**  | yes     | ?       | ?    | ?        | ?   | ?       | n/a  |
| Set temperature and sampling            | **no**  | yes     | ?       | ?    | ?        | ?   | no      | n/a  |
| Git branch or worktree isolation        | partial | yes     | ?       | ?    | ?        | ?   | yes     | n/a  |
| Browser driven for verification         | yes     | no      | ?       | yes  | yes      | ?   | yes     | n/a  |

**Copse: 9 present, 4 partial, 5 absent.**

The five absences cluster, and it is the same cluster three times over: nobody is told when
a run needs them, nothing can be delegated, and no configuration can be named and reused.
Add the four partials and the shape is consistent — the capability is usually built and the
way in is missing.

Two absences are different in kind. Platform reach is a deliberate constraint with a real
cost, and it is the only row where we are behind every competitor including the analytics
tool. Hyperparameters are simply not exposed anywhere.

**The row worth staring at** is _delegate a task and walk away_: yes for four of seven, no
for us, and the one most in tension with what we are. Delegation means the agent proceeds
without you; per-command approval means it stops for you. Whether those coexist is a
product question we have not answered, and copying the feature without answering it
produces a delegation mode that stalls on the first write.

## What each one bets on

Table stakes are what they share. This is what each chose instead, and what the choice
costs — the cost is what says where they will struggle.

### Copse — consent and containment

Per-command approval, an OS-level sandbox, a trusted-command allow-list, no account, no
hosted backend, no product telemetry, and a thread store that is plain files on disk. Also
unusual: two-model comparison, post-turn review, and reading screen recordings as sampled
frames.

_Costs:_ every approval is an interruption, which makes the missing notification and the
missing overview more damaging for us than for anyone else. The bet only pays if being
asked is cheap.

### Piebald — total configurability

Expose every knob and label it. Per-chat and per-profile control of tools and servers, chat
branching, multiple accounts for one service, and raw HTTP traffic inspection, which no one
else offers. Free tier plus Pro at $20/month.

_Costs:_ surface area. It competes on count of settings, a race we should decline rather
than enter.

### Qoder — the repo explains itself

An auto-generated, continuously updated Repo Wiki plus a persistent memory system, on the
theory that agent quality is mostly a context problem. Quest Mode delegates whole specs
against that context. Credit-metered; reportedly Pro $30, Pro+ $60, Ultra $200, Teams $40
per seat.

_Costs:_ generated documentation is wrong sometimes, and wrong documentation fed to an agent
is worse than none. We have the same idea unbuilt in
[#871](https://github.com/copse-dev/agent-pane/issues/871).

### Trae — zero to running app

SOLO mode takes one description and produces frontend, backend, config, terminal commands
and a deployment. Optimised for the first hour of a project. Reportedly Lite $3, Pro $10,
Pro+ $30, Ultra $100, on token-denominated usage balances since early 2026.

_Costs:_ reviewers report it losing cross-file dependencies past roughly fifty thousand
lines. A greenfield bet degrades on the codebases most people actually work in.

### Antigravity — manage tasks, not tool calls

A mission-control view across many agents, and artifacts — plans, task lists, screenshots,
browser recordings — as objects you comment on while the run continues. Verification happens
across editor, terminal and browser.

_Costs:_ it is the direct opposite of our bet. If they are right that people do not want to
approve tool calls, our central premise is wrong, and no feature in this matrix fixes that.

### Zed — be the standard, not the agent

Co-authored the Agent Client Protocol under Apache licence with JetBrains, runs a registry
where an agent registers once and reaches every compatible client, and does not charge for
external agents. Conversations are plain files inside the project, so they version-control
with the code.

_Costs:_ ceding the agent itself. For us this is an opportunity rather than a threat — we
speak both halves of that protocol already (`src/main/services/acp/acp-agent-server.ts`),
so our agent could run inside editors we do not ship. See R-10 in
[`user-control-surface-gaps.md`](user-control-surface-gaps.md).

### Devin — buy engineering hours

No editor. Work is a session, priced in compute units of roughly fifteen minutes, with
subagents specialised by role (plan, execute, verify, debug) and concurrency as a pricing
tier. Reportedly $20 Core, $500 Team, Enterprise custom.

_Costs:_ no local context and no working tree of yours. A different purchase, competing with
contractors more than with editors.

### Span — measure the org, not the code

Delivery metrics, dashboards, and a model that detects AI-generated code at a claimed 95%
accuracy, with the enterprise controls that sale requires: single sign-on, provisioning,
role-based access, audit logs.

_Costs:_ it has to infer authorship from the outside. An agent knows what it wrote as it
writes it, so recording that directly is available to us and to nobody in the analytics
category. Nothing in our trackers covers it.

## Three things this changes

1. **The gap is one gap, not five.** Notification, overview, delegation and named
   configuration are the same missing thing from four angles: nothing tells the user what
   state their work is in. Built separately they produce four partial surfaces. This is why
   [`mission-control.md`](mission-control.md) exists.
2. **Our bet raises the price of those absences.** A tool that asks permission constantly
   needs to be excellent at telling you it is asking. We are currently worst-in-set at that
   while being most dependent on it.
3. **Protocol reach may beat platform reach.** We are behind every competitor on
   operating-system support, and closing that means porting an Electron app. Being available
   inside other editors through a protocol we already implement is a cheaper route to the
   same end.

## Maintenance

This dates fast. Before it informs a decision, confirm the rows that matter against vendor
documentation and treat competitors' own claims as marketing until tested. "Table stakes"
is defined here as present in four or more of the seven, which is a judgement rather than a
measurement.
