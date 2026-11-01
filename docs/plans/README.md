# Plan status

Plans stay in this directory after delivery because they record design rationale,
implementation traps, and deferred decisions. A resolved plan is not an active backlog:
new work should have its own issue or PR and link back to the plan when the history is
useful.

Status meanings:

- **Proposed** — design only; no implementation is on `main`.
- **Active** — implementation or a tracked follow-up is in progress.
- **Resolved** — the plan's scoped outcome is on `main`; explicitly listed follow-ups are
  separate work.
- **Partial / deferred** — a useful slice shipped, while the remaining design is not
  currently active.
- **Superseded** — ownership moved elsewhere; the document remains as history.
- **Reference** — background that other plans cite; nothing to implement. Dates faster than
  a design does, so check its compiled-on date before relying on it.

Full plan/status audit: **2026-10-30** against `main` at `4727fcfa`. Every file in this
directory has exactly one row below. Issue and PR states were checked on that date; recheck the
linked issue before starting work. Use the [current architecture map](../../site/architecture.html)
for implementation ownership rather than treating this index as a shipped-feature list. Finished
task briefs and hand-offs that used to live here are under [`../spikes/`](../spikes/).

## Active

| Plan                                                                                          | Status                            | Tracking and current state                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ACP agents over SSH](acp-over-ssh.md)                                                        | Active (Phase 1 shipped)          | Opt-in remote ACP spawn over SSH ControlMaster (`acpOverSshEnabled`) merged in [#1202]; [#3100] treats ACP-over-SSH as unsandboxed. MCP forwarding and the native-tool bridge over SSH remain; refs [#771].                                                                                                                                                                                                                                        |
| [ACP session continuity](acp-session-continuity.md)                                           | Active                            | The changed-working-directory carry-over shipped, and the `acp-session.json` sidecar codec is in `thread-store` ([#1379]), but the session pool does not use it yet. Remaining: pool wiring (resume, then load), replay reconciliation, discovery and a durable `copse --acp`.                                                                                                                                                                     |
| [Agent loop efficiency guards](agent-loop-efficiency-guards.md)                               | Active (partly landed)            | Fixes 1–3 landed in [#2837] and Fix 7 in [#3277]; [#1436]–[#1438] are closed. The two `EXPLORE_TOOL_NAMES` constants are renamed apart. Fix 0 is implemented: explore results carry harness-copied verbatim excerpts of the subagent's reads. Fixes 4 and 5 are implemented: a plan closed on executed checks finalizes, repeated suite runs are damped, and `cancelled` → `completed` needs a check. Fix 0b (routed reads) remains under [#1433]. |
| [Agent Plugins as the portable pack format](agent-plugins-migration.md)                       | Active (runtime landed)           | Discovery and activation (A) and the rename (C) landed; the install lifecycle shipped with the [marketplace plan](feature-pack-marketplace.md). Built-in manifest conversion (B1/B2) and canonical fire-site dispatch for external SDK function hooks remain; see [plugins](../plugins.md) and [the SDK](../../packages/plugin-sdk/README.md).                                                                                                     |
| [Automations](automations.md)                                                                 | Active (experimental)             | The default-off `copse.automations` plugin, schedule editor, local ticker and **Run now** shipped; event triggers build on it. Durable/headless execution belongs to [#1079]; default-on readiness is [#3071].                                                                                                                                                                                                                                     |
| [Client/server split](client-server-split.md)                                                 | Active (step 1 landed)            | The generated, versioned desktop protocol and step 1a are on `main`, with paired-client services from [#3847] and [#3888]. `ShellHost`, a supported browser transport and repository separation remain; refs [#2312]. See [the protocol contract](../api-protocol.md).                                                                                                                                                                             |
| [Copse engineering workflows](copse-engineering-workflows.md)                                 | Active                            | Opt-in Copse workflows replaced the bundled pstack in [#3926]. A matched real-model evaluation is required before any default-on change.                                                                                                                                                                                                                                                                                                           |
| [Copse Reviewer](copse-reviewer.md)                                                           | Active (Phases 0–5 landed)        | `@copse/review` and the app/CI surfaces landed ([#2849], [#3604]). B8's 85% Martian-offline precision target is unmeasured and the open decisions remain.                                                                                                                                                                                                                                                                                          |
| [Custom subagents](custom-subagents.md)                                                       | Active (P1–P2 landed)             | Discovery, Settings visibility and explicit `/name` invocation shipped in [#1860]; named native workers in [#3897]. [#1819] is closed, so P3–P8 (Codex TOML, gated auto-delegation, plugin agents, background runs) need a new tracking issue.                                                                                                                                                                                                     |
| [Dark-factory PR orchestrator](dark-factory-pr-orchestrator.md)                               | Active (sensor foundation)        | The experimental `copse.dark-factory` plugin and its supervisor sensor are on `main`; the decision record is [#960]. Fleet discovery, GitHub observations, history, incidents and actuators remain.                                                                                                                                                                                                                                                |
| [Deferred approvals](deferred-approvals.md)                                                   | Active (D0–D1 landed)             | Prompt-cause instrumentation, the defer outcome and durable queue, scheduled first-turn deferral and a read-only Context list are implemented. D2 review surface, D3 loop behaviour and D4 consumers with approved-action replay remain.                                                                                                                                                                                                           |
| [Deferred thread worktrees](deferred-thread-worktrees.md)                                     | Active (prototype, opt-in)        | Settings → Experimental → Deferred worktrees ([#3241], [#3568]). The plan's "known gaps before default" list is the remaining work; refs [#4004].                                                                                                                                                                                                                                                                                                  |
| [Demo links](demo-links.md)                                                                   | Active                            | The plan landed in [#986] and the browser-hosted renderer in [#989]. A gallery and broader scenario picker (M1) remain.                                                                                                                                                                                                                                                                                                                            |
| [Edit thread history](edit-thread-history.md)                                                 | Active                            | The initial manual editing release is on `main` ([#3314]); the listed hardening follow-ups remain.                                                                                                                                                                                                                                                                                                                                                 |
| [Event-driven automations](event-driven-automations.md)                                       | Active (partly implemented)       | The durable inbox, PR/issue-label/CI adapters and delivery history shipped (2026-10-07 update). Open: local-task adapter, job-level check filters, per-definition cost allowance, self-retrigger protection, webhooks and pending coalescing.                                                                                                                                                                                                      |
| [Feature-pack marketplace](feature-pack-marketplace.md)                                       | Active (first slice implemented)  | Install, pin, update and rollback for pinned, unsigned skills/MCP packages are implemented (`plugin-install-service.ts`). Signing and publisher verification, arbitrary index URLs, update channels and executable installs remain; refs [#4003] ([#1082] closed).                                                                                                                                                                                 |
| [First-class video input and visual evidence](first-class-video-input-and-visual-evidence.md) | Active                            | Refs [#2694]. U1, the browser portion of U5 and a first U6 slice shipped. ACP publication, frame sequences and clips, U2–U4 and U7–U12 remain.                                                                                                                                                                                                                                                                                                     |
| [Sandboxed artifact image downloads](sandboxed-artifact-image-downloads.md)                   | Active (Linux partial)            | Main no longer fetches remote artifact images: a per-job host with its own ASRT manager and egress proxy runs a credential-free confined downloader ([#4030]). Linux is partially validated (seccomp Unix-socket filter off); macOS is unvalidated and Cursor's download origin unconfirmed; refs [#4005].                                                                                                                                         |
| [Working at fleet scale](fleet-scale.md)                                                      | Active (partly implemented)       | C3 ([#1663]) and C7 ([#1667]) merged; C2 is covered by dated, owned quarantine entries ([#2720]); C1 started in [#3806]; P1 shipped as the Activity view and P2's sensor exists. C4–C6, P3–P6 and Part 3 remain.                                                                                                                                                                                                                                   |
| [Headless automation contract](headless-automation-contract.md)                               | Active (Phases 0–1 landed)        | Refs [#1079]. The zod contract (`packages/agent/src/headless-contract.ts`), its published schema and the benchmark consumer are on `main`. Phase 2 spine projection, Phase 3 ACP conformance and Phase 4 CLI remain. [#1095] closed unmerged; this plan is the binding contract.                                                                                                                                                                   |
| [Hooks and feature packs](hooks-and-feature-packs.md)                                         | Active (platform landed)          | Canonical hooks, dialect adapters (`packages/hooks-dialects`) and the plugin lifecycle are implemented; its decisions log is binding. Remaining: C5 `loop_limit` enforcement, P15 ([#1336]), P16 and canonical fire-site dispatch for SDK function hooks.                                                                                                                                                                                          |
| [Industry benchmarks](industry-benchmarks.md)                                                 | Active                            | Refs [#752]. Deterministic corpora and the Phase-2 headless harness ([#753]) plus the Terminal-Bench and SkillsBench lanes (`bench:terminal:*`, `bench:skills:*`) are on `main`. Running benchmarks on the real agent path is [#1272].                                                                                                                                                                                                             |
| [Library splits](library-splits.md)                                                           | Active (extractions landed)       | Refs [#2303]. Host-independent packages include std, shell-guard, thread-store, hooks-dialects, plugin-sdk, procwatch, store-kit, review and remote-protocol alongside agent, llm and plan-usage. Remaining: [#2310]–[#2313].                                                                                                                                                                                                                      |
| [Linux sandbox rollout follow-ups](linux-sandbox-rollout-followups.md)                        | Active                            | The rollout ([#1440]–[#1442]) is on `main` and items 1–3 are resolved. Item 4 (screenshot churn), item 5 (`dist.tar` ordering in `ci.yml`) and item 6 (platform-proxy sweep) remain.                                                                                                                                                                                                                                                               |
| [Long-horizon tasks](long-horizon-tasks.md)                                                   | Active (experimental scaffold)    | Refs [#558]. The off-by-default `copse.long-horizon-tasks` plugin ([#561], [#1084]) and supervised wakes ([#3900]) are on `main`. Commit cadence, status surfacing and CI-loop integration remain.                                                                                                                                                                                                                                                 |
| [Main gate shaping](main-gate-shaping.md)                                                     | Active (shadow running)           | Item 2 of [recovery throughput](recovery-throughput.md). The shadow report has run since 2026-10-17 with no policy change. The four-week shadow and its qualifying replays come first; any gate change lands as its own PR.                                                                                                                                                                                                                        |
| [Knowing what your agents are doing](mission-control.md)                                      | Active (slice 1 landed)           | The Activity panel and the [new-thread activity screen](new-thread-activity-screen.md) shipped. Stalled detection, disposition, delivery state on rows, filter/search, notifications and cross-window aggregation remain.                                                                                                                                                                                                                          |
| [Mobile web experience](mobile-web-experience.md)                                             | Active (experimental)             | Refs [#659]. An opt-in LAN companion with pairing, HTTPS, chat, stop, questions and one-shot approvals is implemented. Diff reading, live streaming, certificate-install UX and physical-device validation remain.                                                                                                                                                                                                                                 |
| [Model classifier](model-classifier.md)                                                       | Active                            | Refs [#557] (closed) and follow-ups [#4001]. **Match task** primary routing ([#3594]) and cost-aware tier selection ([#920]) are on `main`, plus an experimental advisory tool. Sharing the assessment with `suggest_model` and subagents, outcome feedback and latency metadata remain.                                                                                                                                                           |
| [Model roles and defaults](model-roles-and-defaults.md)                                       | Active                            | Phases 0–2 and the Phase-3 backend foundation are on `main` through [#754] and [#1018]. Generalized download UI and light evals remain.                                                                                                                                                                                                                                                                                                            |
| [Plan Mode and rewind](plan-mode-and-rewind.md)                                               | Active                            | Refs [#1080]. The living plan workflow (editable revisions, approval, completion evidence) is on `main` ([#3747]); prompt-boundary rewind remains.                                                                                                                                                                                                                                                                                                 |
| [Plugin capability API](plugin-capability-api.md)                                             | Active                            | Stage 1 is implemented, with first-party session-only previews for approvals ([#3847]) and activity and navigation ([#3888]). Provider registration, consent and transports, projections and compatibility evidence (stages 2–5) remain.                                                                                                                                                                                                           |
| [PR panel GitHub parity](pr-panel-github-parity.md)                                           | Active                            | PR 1 (pull request activity tabs) landed in 3580a0f19. PRs 2–8 (comment writes, inline threads, reply/resolve, CI controls, commits, merge readiness, discovery) remain.                                                                                                                                                                                                                                                                           |
| [Project worktree preparation](project-worktree-preparation.md)                               | Active                            | The foundation ([#2388]) and JS, uv/pip, Go and Cargo adapters are on `main`. JVM, .NET, Ruby and PHP adapters remain under [#2655].                                                                                                                                                                                                                                                                                                               |
| [Release-readiness milestone 2](release-readiness-milestone-2.md)                             | Active portfolio                  | [Milestone 2](https://github.com/copse-dev/agent-pane/milestone/2) has 13 open items. [#802] (public stable distribution and update channel) is the only remaining `ga-blocker`.                                                                                                                                                                                                                                                                   |
| [Screen capture and remote video](screen-capture-and-remote-video.md)                         | Active (P0 implemented)           | P0 (the bounded SSH binary-media foundation, U1 in the umbrella plan) shipped; P1–P5 are proposed. Ownership sits with the [first-class video plan](first-class-video-input-and-visual-evidence.md) and [#2694].                                                                                                                                                                                                                                   |
| [Screenshot evidence reuse](screenshot-evidence-reuse.md)                                     | Active (shadow instrument landed) | The rendering-input identity is recorded as an observe-only CI artifact ([#3783]). Nothing reads it yet; the determinism measurement must clear its threshold before a separate reuse-policy PR.                                                                                                                                                                                                                                                   |
| [Shipping quality roadmap](sdlc-improvement-roadmap.md)                                       | Active                            | Refs [#1373]; based on the [2026-09-20 assessment](../sdlc-review-2026-09-20.md). R01 ([#2718]) and R11 ([#2520]) are closed. R02–R10, R13, R14 and the R03 owner/expiry work ([#2719]) remain.                                                                                                                                                                                                                                                    |
| [Settings transparency](settings-transparency.md)                                             | Active                            | The Sources panel and instruction parity ([#635]) and Cursor rule scoping ([#900]) shipped. Honouring `.claude/settings.json` `permissions`/`env` keys ([#639]) and Cursor "Rules for AI" import ([#638]) remain.                                                                                                                                                                                                                                  |
| [Running a thread inside a container](thread-in-container.md)                                 | Active (experimental on main)     | Local Docker execution is implemented and off by default (`containerRunsEnabled`), with attested containment and a stdio egress broker. T1 real-provider runs, T2 attach/writer lease, T3 host-side replay review and T4 hardening remain.                                                                                                                                                                                                         |
| [UI kit](ui-kit.md)                                                                           | Active                            | `.ui-btn*` CSS and light-DOM `<copse-ui-actions>` / `<copse-ui-field>` are on `main` ([#1150]), and the Browser/Terminals pane-tabs shell shipped in [#3944]. The list+viewer shell remains; Shadow DOM is deferred.                                                                                                                                                                                                                               |
| [VNC remote desktop](vnc-remote-desktop.md)                                                   | Active (V0/V1 first release)      | The opt-in, read-only Desktop pane connects to loopback or an SSH workspace through loopback-only forwards and bundled noVNC. Reconnect reconciliation, a generic browser consumer and the live-host harness remain; V2+ input and agent control stay unimplemented.                                                                                                                                                                               |

## Partial / deferred

| Plan                                                                    | Status                       | Tracking and current state                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Advisor strategy](advisor-strategy.md)                                 | Partial / deferred           | [#566] is closed; the scaffold ([#567]), plugin extraction ([#1090]) and token billing ([#918]) shipped. The out-of-scope follow-ups (native server tool, prompting and call cap) have no open issue.                                                                            |
| [Multiple main windows](multi-window-architecture.md)                   | Partial / deferred           | Window registry, New Window, independent navigation and restart restoration are implemented and covered by `multiple-main-windows.e2e.ts`. The full concurrency/display matrix and profile/account work remain.                                                                  |
| [Portable development environment](portable-development-environment.md) | Partial / deferred           | The Apple Silicon preview is documented in [`portable-development.md`](../portable-development.md). Bundling Git, Python and the SDK, other hosts and user-data migration remain. Consolidation candidate with the drive-portability and device-bound-encryption plans.          |
| [Recovery lessons and development throughput](recovery-throughput.md)   | Partial / deferred           | Recovery tooling shipped with [#3770]. Its children [main gate shaping](main-gate-shaping.md) and [screenshot evidence reuse](screenshot-evidence-reuse.md) carry the remaining screenshot and CI proposals.                                                                     |
| [SkillsBench](skillsbench.md)                                           | Partial / deferred           | The Scaleway spike is implemented (`benchmarks/skillsbench/`, [#3279], [#3280]); a cohort study that can resolve a skill effect has not been run ([#1311], [#1315]).                                                                                                             |
| [Tauri + Servo migration](tauri-servo-migration.md)                     | Partial / deferred (dormant) | Phase 1 is on `main` (`src/sidecar/`, `pnpm build:servo`, [servo mode](../servo-mode.md)); the shell moved to [copse-dev/tauri-shell](https://github.com/copse-dev/tauri-shell) in [#1942]. Phases 2–5 are unscheduled. `tauri-patches/` and `perf-data*/` belong to this track. |
| [Terminal file links](terminal-file-links-improvements.md)              | Partial / deferred           | File links and line/column navigation shipped in [#415]. Cwd-aware resolution is deferred.                                                                                                                                                                                       |
| [Tool-output handling](tool-output-handling.md)                         | Partial / deferred           | PRs A and B (evidence-preserving caps) shipped in [#3415]. Next: A2 (`runCommand` keeps the real tail), then C (spill `run_shell` output to the thread store); D–F are designs.                                                                                                  |

## Proposed

| Plan                                                                        | Status                            | Tracking and current state                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ACP adapter install lock](acp-adapter-install-lock.md)                     | Proposed                          | Auto-setup still installs adapters with a global npm install. Proposes a committed `acp-adapters.lock.json`, an app-owned install tree, `npm ci` integrity checks and a cooldown-gated CI promotion pipeline; extends [supply-chain-security.md](../supply-chain-security.md). |
| [ACP v2 execution boundary](acp-v2-execution-boundary.md)                   | Proposed (needs a decision)       | Design record from [#3830]. After the decision, accept or revert the "Proposed revision (2026-10-16)" edits it made in six other plans.                                                                                                                                        |
| [Agent coordination](agent-coordination.md)                                 | Proposed (prototype, not enabled) | A runnable protocol prototype and scripted Electron demo ([#3238], `scripts/prototypes/agent-coordination/`). Nothing is enabled in the product.                                                                                                                               |
| [Autonomous debugging flow](autonomous-debugging-flow.md)                   | Proposed (Phase 0 landed)         | The Phase 0 regression harness (`eval:autonomy*`) shipped in [#1476]. Phases 1–5 reuse [#1079], [#656] and the existing eval owners rather than creating another umbrella.                                                                                                     |
| [Copse cloud workspaces](copse-cloud-workspaces.md)                         | Proposed                          | The app-level provision/attach workflow is not implemented; its SSH workspace and remote-e2e prerequisites have shipped.                                                                                                                                                       |
| [Offloading the harness to another device](cross-device-harness-offload.md) | Proposed (partly overtaken)       | [`thread-in-container.md`](thread-in-container.md) delivered O0/O3/O4 for a local container. What is left is ownership: O1 fenced writer lease and O2 attach/detach.                                                                                                           |
| [Device-bound profile encryption](device-bound-profile-encryption.md)       | Proposed                          | Touch ID-backed, device-bound profile keys; no code on `main`. Part of the portable-environment family with [drive portability](drive-portability-audit.md).                                                                                                                   |
| [Documentation site](docs-site.md)                                          | Proposed                          | Nothing implemented. Proposes a seven-section user manual under `copse.dev/docs/` built by `pages.yml`; `docs/` stays the contributor archive.                                                                                                                                 |
| [Drive portability audit](drive-portability-audit.md)                       | Proposed                          | 2026-09-11 audit after [#2657]. Six slices remain (kit manifest and preflight, project relocation, controlled env, local-only policy, writer guard, offline bundle); overlaps [portable development](portable-development-environment.md).                                     |
| [Execution runtime security](execution-runtime-security.md)                 | Proposed (partly overtaken)       | Container-runtime slices of R0/R2 shipped through thread-in-container ([#3105]) and the Linux sandbox through [#1440]. The shared `ExecutionRuntime` adapter, principals and audit (R1), the local/SSH GitHub broker (R2) and R3–R6 remain.                                    |
| [Bring-your-own Managed Agents environments](managed-agent-environments.md) | Proposed                          | Nothing implemented; `managed-agents-client.ts` still hardcodes the Anthropic-hosted environment. P1 is a narrow per-project settings overlay.                                                                                                                                 |
| [MCP Apps host support](mcp-apps-support.md)                                | Proposed                          | Plan for a standards-based MCP Apps host under [#611]. [#611] was auto-closed by the docs-only [#3607]; no host code exists. The legacy HTML canvas remains the only implementation.                                                                                           |
| [System-prompt context audit](system-prompt-context-audit.md)               | Proposed (findings only)          | The `Available tools:` roster (now in `agent-prompt-sections.ts`) still duplicates tool `description:` fields. Model-family prompt profiles ([#3323]) cover part of the provider-split notes.                                                                                  |
| [TypeSafe.ai decision engine](typesafe-ai-decision-engine.md)               | Proposed                          | Evaluation-first, default-off integration; Roadmap metadata is the only initial candidate. A generic `typesafe` classifier preset already exists ([#2975]); this plan still excludes permission and safety authority.                                                          |
| [Unattended runs on a contained runtime](unattended-runs.md)                | Proposed (partly overtaken)       | [`thread-in-container.md`](thread-in-container.md) prototypes the mode with the loop in the guest. Decisions 1 and 3 are to be revised together with that plan.                                                                                                                |

## Resolved

| Plan                                                                     | Status                            | Tracking and current state                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ACP client support](acp-client-support.md)                              | Resolved core                     | [#264] is closed. Protocol core, Settings, MCP/native-tool forwarding and the session pool shipped. Continuity is owned by [session continuity](acp-session-continuity.md), remote agents by [ACP over SSH](acp-over-ssh.md), and `terminal/*` by [#623]. |
| [Auto-approval classifier](auto-approval-classifier.md)                  | Resolved                          | Deterministic allow-list of low-risk command shapes behind `shellAutoApprovalLevel` (default `read`). No model verdict participates.                                                                                                                      |
| [Background task supervisor](background-supervisor.md)                   | Resolved                          | [#1081] is closed; the shared durable supervisor (P1–P7) is on `main`. Campaign orchestration and A2A ([#1015]) are separate follow-ups.                                                                                                                  |
| [CI base freshness](ci-base-freshness.md)                                | Resolved                          | Reporting and bounded refresh shipped in [#2974]; [#2520] is closed. The enforcement decision belongs to [main gate shaping](main-gate-shaping.md).                                                                                                       |
| [CI cancellation gate](ci-cancellation-gate.md)                          | Resolved                          | Shipped in [#2722]; [#2520] is closed.                                                                                                                                                                                                                    |
| [Classifier providers](classifier-providers.md)                          | Resolved                          | Shipped in [#2975]; user documentation is [`classifier-providers.md`](../classifier-providers.md).                                                                                                                                                        |
| [Command sandboxing routing](command-sandboxing-routing.md)              | Resolved                          | The safe trusted-command allow-list shipped in [#700]. Read-only and container tiers are deliberately deferred.                                                                                                                                           |
| [Context provenance](context-provenance.md)                              | Resolved                          | All four phases shipped ([#1827], [#1829], [#1828], [#1834]) with an injection steer-eval corpus ([#1837]). Prompt framing is defence in depth; permission behaviour belongs to [shell-permissions.md](../shell-permissions.md).                          |
| [Demo links: per-PR previews](demo-links-per-pr-previews.md)             | Resolved                          | Same-repo PRs publish to `copse.dev/demo/pr-<n>/` through `demo-preview.yml`. Fork fallback and origin isolation are follow-ups.                                                                                                                          |
| [Doctrine compliance evals](doctrine-compliance-evals.md)                | Resolved                          | Phase 1 ([#1146]) and the model-backed `eval:doctrine` matrix shipped; [#744] is closed. [#745] and [#750] are separate follow-ups.                                                                                                                       |
| [Environment setup](environment-setup.md)                                | Resolved                          | Phases 1–3 shipped in [#3950]. Classifier context is deliberately later work.                                                                                                                                                                             |
| [Event automation inbox](event-automation-inbox.md)                      | Resolved                          | Slice A of [#2594]: the admission/recovery inbox, installed at app startup by the branch CI adapter. Further work is tracked in [event-driven automations](event-driven-automations.md).                                                                  |
| [Gate artifact backfill](gate-artifact-backfill.md)                      | Resolved (one-off record)         | The structured gate-evidence backfill from [#3815]; it is the main referrer of `evidence/`. Consolidation candidate with the other main-gate shadow docs.                                                                                                 |
| [Machines and native remote model routing](machines-model-routing.md)    | Resolved (experimental)           | Experimental LAN System One model sharing shipped in [#3377]. Standalone packaging, an internet relay and two-machine validation are follow-ups.                                                                                                          |
| [Main gate replay report](main-gate-replay-report.md)                    | Resolved (runbook)                | The replay report pipeline shipped in [#3813]. Consolidation candidate under [main gate shaping](main-gate-shaping.md).                                                                                                                                   |
| [Main gate report automation](main-gate-report-automation.md)            | Resolved (runbook)                | `gate-shadow-report.yml` runs daily ([#3814]). Consolidation candidate under [main gate shaping](main-gate-shaping.md).                                                                                                                                   |
| [Main gate shadow: first slice](main-gate-shadow-first-slice.md)         | Resolved (runbook)                | The shadow artifacts shipped in [#3806]. Consolidation candidate under [main gate shaping](main-gate-shaping.md).                                                                                                                                         |
| [Knowledge store](knowledge-store.md)                                    | Resolved core; surfacing deferred | [#645] is closed. The OKF store, roadmap and memories migrations ([#1088], [#1089]) are on `main`. Prompt-time knowledge surfacing is tracked by [#870].                                                                                                  |
| [Native named workers](native-readonly-workers.md)                       | Resolved                          | Read-only named workers shipped in [#3897].                                                                                                                                                                                                               |
| [Isolated writable workers](native-writable-workers.md)                  | Resolved                          | `run_isolated_workers` shipped in [#3897].                                                                                                                                                                                                                |
| [Referenced-path instruction discovery](nested-instruction-discovery.md) | Resolved                          | Bounded per-turn ancestor reads for nested `AGENTS.md`.                                                                                                                                                                                                   |
| [New-thread activity screen](new-thread-activity-screen.md)              | Resolved                          | Every slice merged by 2026-10-11 ([#3455]–[#3588]). Its "intentionally left" items are optional.                                                                                                                                                          |
| [OpenAI cloud agent prototype](openai-cloud-agent-prototype.md)          | Resolved (experimental)           | Shipped in [#3584]. Live OpenAI inference and GitHub push validation are still outstanding.                                                                                                                                                               |
| [OpenAI service tier surface](openai-service-tier-surface.md)            | Resolved                          | Settings → Providers → OpenAI offers a Project default / Standard / Flex / Fast picker; actual response tiers drive the pricing from [#2759].                                                                                                             |
| [Orchestration strategy](orchestration-pattern.md)                       | Resolved                          | The experimental, off-by-default scaffold shipped in [#969].                                                                                                                                                                                              |
| [Package firewall](package-firewall.md)                                  | Resolved (phase 1)                | The in-repo firewall replaced `sfw` in [#3915]. Bun/RubyGems detection, strict mode and metadata filtering are unfiled follow-ups.                                                                                                                        |
| [Product announcements](product-announcements.md)                        | Resolved                          | Once-per-profile announcements are implemented; the plan doubles as the how-to for adding one.                                                                                                                                                            |
| [Provider host allow-list](provider-host-allowlist.md)                   | Resolved                          | [#438] is closed; the policy and Settings UI shipped in [#876].                                                                                                                                                                                           |
| [Dynamic read-sandbox relaxation](read-outside-sandbox-relaxation.md)    | Resolved                          | Read-outside grants are implemented in `shell-tool.ts`; the plan records where the build diverged from the design.                                                                                                                                        |
| [Recoverable edit checkpoints](recoverable-edit-checkpoints.md)          | Resolved                          | Shipped in [#2629].                                                                                                                                                                                                                                       |
| [Remote e2e development loop](remote-e2e-dev-loop.md)                    | Resolved                          | M0–M4 shipped in [#972], with registry-backed startup improvements in [#980].                                                                                                                                                                             |
| [Roadmap plans](roadmap-plans.md)                                        | Resolved core                     | [#556] is closed; plugin extraction is [#1089] and the living-plan prototype builds on [#3747]. The remaining follow-ups need a new issue.                                                                                                                |
| [Sandbox network scope isolation](sandbox-network-scope-isolation.md)    | Resolved (Phases 1–5)             | Probe teardown, scope labelling, capability-based gating, a probe helper process and per-agent host processes for pooled ACP sessions all shipped.                                                                                                        |
| [Bounded skill dependencies](skill-dependencies.md)                      | Resolved                          | Shipped in [#3895], including child/ACP access.                                                                                                                                                                                                           |
| [SSH remote repositories](ssh-remote-repo.md)                            | Resolved core                     | The remote workspace stack shipped in [#942] and ACP-over-SSH Phase 1 in [#1202]. Remote port forwarding ([#771]) and semantic indexing remain separate.                                                                                                  |
| [Finished-thread archival](thread-auto-archive.md)                       | Resolved                          | Shipped in [#3871]; follow-up work is [#3877].                                                                                                                                                                                                            |
| [Thread layout stability](thread-layout-stability.md)                    | Resolved core                     | The disclosure policy, stable reconciliation and reading-anchor preservation are on `main` (f9989cb26, [#3967]). Scroll coalescing and an always-compact comparison remain optional experiments.                                                          |
| [Thread referencing](thread-referencing.md)                              | Resolved core                     | [#647] shipped the filesystem-native store and `@` references; lazy loading closed with [#998]. Streaming partial persistence remains separate.                                                                                                           |
| [Per-thread worktrees](thread-worktrees.md)                              | Resolved                          | [#869] is closed; the stack from [#1029] onward is on `main`. Residual work lives in [#1882], [#2475] and [#2476].                                                                                                                                        |
| [Shared Apple and Android app running](unified-app-run.md)               | Resolved                          | Shipped in [#2677], following [#2667].                                                                                                                                                                                                                    |

## Superseded

| Plan                                                          | Status     | Tracking and current state                                                                                                                                                           |
| ------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Markdown renderer hardening](markdown-renderer-hardening.md) | Superseded | The renderer moved to [`@copse/streaming-markdown`](https://github.com/copse-dev/streaming-markdown), now consumed at 1.x; sanitization, fuzzing and conformance are owned upstream. |

## Reference

| Plan                                                                        | Status                     | Tracking and current state                                                                                                                                     |
| --------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Background agents capability map](background-agents-capability-map.md)     | Reference (2026-07-30)     | Audit against the background-agents.com primitives. The supervisor and event triggers have shipped since, so several gaps are partly closed.                   |
| [Codex OSS architecture comparison](codex-oss-architecture-comparison.md)   | Reference (2026-07-19)     | Historical comparison ([#1036]); ownership moved to [execution runtime security](execution-runtime-security.md).                                               |
| [Competitive landscape](competitive-landscape.md)                           | Reference (2026-07-27)     | Snapshot of seven products next to Copse, supporting the [control-surface audit](user-control-surface-gaps.md). Mixed source confidence.                       |
| [Default-on readiness](default-on-readiness.md)                             | Reference (2026-09-25)     | Audit of every experimental plugin and toggle. Fix PRs [#3098]–[#3118] merged; the seven "enable after X" follow-ups are [#3068]–[#3074].                      |
| [Grok Build architecture comparison](grok-build-architecture-comparison.md) | Reference                  | Comparison and follow-up ownership map ([#1078]). Of its follow-ups, [#1081] is closed and [#1079], [#1080] and [#1082] are open.                              |
| [Native SVG layout in Servo](servo-svg-layout.md)                           | Reference                  | Prior art and cost for SVG in Servo ([#1906]); the prototype it costed landed in [#1909]. Part of the dormant [Tauri + Servo](tauri-servo-migration.md) track. |
| [Unowned capability gaps](unowned-capability-gaps.md)                       | Reference audit, dispersed | 2026-08-07 audit. Its findings moved to [#1570], [#1571], [#1572] (closed) and [#1573] (open), plus amendments to eight documents.                             |
| [User control surface gaps](user-control-surface-gaps.md)                   | Reference (dated audit)    | R-01–R-22 ownership audit. Many owners have closed since; [mission control](mission-control.md) and the open issues own what remains.                          |

<!-- Issue and pull request links. GitHub redirects /issues/N to /pull/N for pull requests. -->

[#264]: https://github.com/copse-dev/agent-pane/issues/264
[#415]: https://github.com/copse-dev/agent-pane/issues/415
[#438]: https://github.com/copse-dev/agent-pane/issues/438
[#556]: https://github.com/copse-dev/agent-pane/issues/556
[#557]: https://github.com/copse-dev/agent-pane/issues/557
[#558]: https://github.com/copse-dev/agent-pane/issues/558
[#561]: https://github.com/copse-dev/agent-pane/issues/561
[#566]: https://github.com/copse-dev/agent-pane/issues/566
[#567]: https://github.com/copse-dev/agent-pane/issues/567
[#611]: https://github.com/copse-dev/agent-pane/issues/611
[#623]: https://github.com/copse-dev/agent-pane/issues/623
[#635]: https://github.com/copse-dev/agent-pane/issues/635
[#638]: https://github.com/copse-dev/agent-pane/issues/638
[#639]: https://github.com/copse-dev/agent-pane/issues/639
[#645]: https://github.com/copse-dev/agent-pane/issues/645
[#647]: https://github.com/copse-dev/agent-pane/issues/647
[#656]: https://github.com/copse-dev/agent-pane/issues/656
[#659]: https://github.com/copse-dev/agent-pane/issues/659
[#700]: https://github.com/copse-dev/agent-pane/issues/700
[#744]: https://github.com/copse-dev/agent-pane/issues/744
[#745]: https://github.com/copse-dev/agent-pane/issues/745
[#750]: https://github.com/copse-dev/agent-pane/issues/750
[#752]: https://github.com/copse-dev/agent-pane/issues/752
[#753]: https://github.com/copse-dev/agent-pane/issues/753
[#754]: https://github.com/copse-dev/agent-pane/issues/754
[#771]: https://github.com/copse-dev/agent-pane/issues/771
[#802]: https://github.com/copse-dev/agent-pane/issues/802
[#869]: https://github.com/copse-dev/agent-pane/issues/869
[#876]: https://github.com/copse-dev/agent-pane/issues/876
[#900]: https://github.com/copse-dev/agent-pane/issues/900
[#918]: https://github.com/copse-dev/agent-pane/issues/918
[#920]: https://github.com/copse-dev/agent-pane/issues/920
[#942]: https://github.com/copse-dev/agent-pane/issues/942
[#960]: https://github.com/copse-dev/agent-pane/issues/960
[#969]: https://github.com/copse-dev/agent-pane/issues/969
[#972]: https://github.com/copse-dev/agent-pane/issues/972
[#980]: https://github.com/copse-dev/agent-pane/issues/980
[#986]: https://github.com/copse-dev/agent-pane/issues/986
[#989]: https://github.com/copse-dev/agent-pane/issues/989
[#998]: https://github.com/copse-dev/agent-pane/issues/998
[#1015]: https://github.com/copse-dev/agent-pane/issues/1015
[#1018]: https://github.com/copse-dev/agent-pane/issues/1018
[#1029]: https://github.com/copse-dev/agent-pane/issues/1029
[#1036]: https://github.com/copse-dev/agent-pane/issues/1036
[#1078]: https://github.com/copse-dev/agent-pane/issues/1078
[#1079]: https://github.com/copse-dev/agent-pane/issues/1079
[#1080]: https://github.com/copse-dev/agent-pane/issues/1080
[#1081]: https://github.com/copse-dev/agent-pane/issues/1081
[#1082]: https://github.com/copse-dev/agent-pane/issues/1082
[#1084]: https://github.com/copse-dev/agent-pane/issues/1084
[#1088]: https://github.com/copse-dev/agent-pane/issues/1088
[#1089]: https://github.com/copse-dev/agent-pane/issues/1089
[#1090]: https://github.com/copse-dev/agent-pane/issues/1090
[#1095]: https://github.com/copse-dev/agent-pane/issues/1095
[#1146]: https://github.com/copse-dev/agent-pane/issues/1146
[#1150]: https://github.com/copse-dev/agent-pane/issues/1150
[#1202]: https://github.com/copse-dev/agent-pane/issues/1202
[#1272]: https://github.com/copse-dev/agent-pane/issues/1272
[#1311]: https://github.com/copse-dev/agent-pane/issues/1311
[#1315]: https://github.com/copse-dev/agent-pane/issues/1315
[#1336]: https://github.com/copse-dev/agent-pane/issues/1336
[#1373]: https://github.com/copse-dev/agent-pane/issues/1373
[#1379]: https://github.com/copse-dev/agent-pane/issues/1379
[#1433]: https://github.com/copse-dev/agent-pane/issues/1433
[#1436]: https://github.com/copse-dev/agent-pane/issues/1436
[#1438]: https://github.com/copse-dev/agent-pane/issues/1438
[#1440]: https://github.com/copse-dev/agent-pane/issues/1440
[#1442]: https://github.com/copse-dev/agent-pane/issues/1442
[#1476]: https://github.com/copse-dev/agent-pane/issues/1476
[#1570]: https://github.com/copse-dev/agent-pane/issues/1570
[#1571]: https://github.com/copse-dev/agent-pane/issues/1571
[#1572]: https://github.com/copse-dev/agent-pane/issues/1572
[#1573]: https://github.com/copse-dev/agent-pane/issues/1573
[#1663]: https://github.com/copse-dev/agent-pane/issues/1663
[#1667]: https://github.com/copse-dev/agent-pane/issues/1667
[#1819]: https://github.com/copse-dev/agent-pane/issues/1819
[#1827]: https://github.com/copse-dev/agent-pane/issues/1827
[#1828]: https://github.com/copse-dev/agent-pane/issues/1828
[#1829]: https://github.com/copse-dev/agent-pane/issues/1829
[#1834]: https://github.com/copse-dev/agent-pane/issues/1834
[#1837]: https://github.com/copse-dev/agent-pane/issues/1837
[#1860]: https://github.com/copse-dev/agent-pane/issues/1860
[#1882]: https://github.com/copse-dev/agent-pane/issues/1882
[#1906]: https://github.com/copse-dev/agent-pane/issues/1906
[#1909]: https://github.com/copse-dev/agent-pane/issues/1909
[#1942]: https://github.com/copse-dev/agent-pane/issues/1942
[#2303]: https://github.com/copse-dev/agent-pane/issues/2303
[#2310]: https://github.com/copse-dev/agent-pane/issues/2310
[#2312]: https://github.com/copse-dev/agent-pane/issues/2312
[#2313]: https://github.com/copse-dev/agent-pane/issues/2313
[#2388]: https://github.com/copse-dev/agent-pane/issues/2388
[#2475]: https://github.com/copse-dev/agent-pane/issues/2475
[#2476]: https://github.com/copse-dev/agent-pane/issues/2476
[#2520]: https://github.com/copse-dev/agent-pane/issues/2520
[#2594]: https://github.com/copse-dev/agent-pane/issues/2594
[#2629]: https://github.com/copse-dev/agent-pane/issues/2629
[#2655]: https://github.com/copse-dev/agent-pane/issues/2655
[#2657]: https://github.com/copse-dev/agent-pane/issues/2657
[#2667]: https://github.com/copse-dev/agent-pane/issues/2667
[#2677]: https://github.com/copse-dev/agent-pane/issues/2677
[#2694]: https://github.com/copse-dev/agent-pane/issues/2694
[#2718]: https://github.com/copse-dev/agent-pane/issues/2718
[#2719]: https://github.com/copse-dev/agent-pane/issues/2719
[#2720]: https://github.com/copse-dev/agent-pane/issues/2720
[#2722]: https://github.com/copse-dev/agent-pane/issues/2722
[#2759]: https://github.com/copse-dev/agent-pane/issues/2759
[#2837]: https://github.com/copse-dev/agent-pane/issues/2837
[#2849]: https://github.com/copse-dev/agent-pane/issues/2849
[#2974]: https://github.com/copse-dev/agent-pane/issues/2974
[#2975]: https://github.com/copse-dev/agent-pane/issues/2975
[#3068]: https://github.com/copse-dev/agent-pane/issues/3068
[#3071]: https://github.com/copse-dev/agent-pane/issues/3071
[#3074]: https://github.com/copse-dev/agent-pane/issues/3074
[#3098]: https://github.com/copse-dev/agent-pane/issues/3098
[#3100]: https://github.com/copse-dev/agent-pane/issues/3100
[#3105]: https://github.com/copse-dev/agent-pane/issues/3105
[#3118]: https://github.com/copse-dev/agent-pane/issues/3118
[#3238]: https://github.com/copse-dev/agent-pane/issues/3238
[#3241]: https://github.com/copse-dev/agent-pane/issues/3241
[#3277]: https://github.com/copse-dev/agent-pane/issues/3277
[#3279]: https://github.com/copse-dev/agent-pane/issues/3279
[#3280]: https://github.com/copse-dev/agent-pane/issues/3280
[#3314]: https://github.com/copse-dev/agent-pane/issues/3314
[#3323]: https://github.com/copse-dev/agent-pane/issues/3323
[#3377]: https://github.com/copse-dev/agent-pane/issues/3377
[#3415]: https://github.com/copse-dev/agent-pane/issues/3415
[#3455]: https://github.com/copse-dev/agent-pane/issues/3455
[#3568]: https://github.com/copse-dev/agent-pane/issues/3568
[#3584]: https://github.com/copse-dev/agent-pane/issues/3584
[#3588]: https://github.com/copse-dev/agent-pane/issues/3588
[#3594]: https://github.com/copse-dev/agent-pane/issues/3594
[#3604]: https://github.com/copse-dev/agent-pane/issues/3604
[#3607]: https://github.com/copse-dev/agent-pane/issues/3607
[#3747]: https://github.com/copse-dev/agent-pane/issues/3747
[#3770]: https://github.com/copse-dev/agent-pane/issues/3770
[#3783]: https://github.com/copse-dev/agent-pane/issues/3783
[#3806]: https://github.com/copse-dev/agent-pane/issues/3806
[#3813]: https://github.com/copse-dev/agent-pane/issues/3813
[#3814]: https://github.com/copse-dev/agent-pane/issues/3814
[#3815]: https://github.com/copse-dev/agent-pane/issues/3815
[#3830]: https://github.com/copse-dev/agent-pane/issues/3830
[#3847]: https://github.com/copse-dev/agent-pane/issues/3847
[#3871]: https://github.com/copse-dev/agent-pane/issues/3871
[#3877]: https://github.com/copse-dev/agent-pane/issues/3877
[#3888]: https://github.com/copse-dev/agent-pane/issues/3888
[#3895]: https://github.com/copse-dev/agent-pane/issues/3895
[#3897]: https://github.com/copse-dev/agent-pane/issues/3897
[#3900]: https://github.com/copse-dev/agent-pane/issues/3900
[#3915]: https://github.com/copse-dev/agent-pane/issues/3915
[#3926]: https://github.com/copse-dev/agent-pane/issues/3926
[#3944]: https://github.com/copse-dev/agent-pane/issues/3944
[#3950]: https://github.com/copse-dev/agent-pane/issues/3950
[#3967]: https://github.com/copse-dev/agent-pane/issues/3967
[#870]: https://github.com/copse-dev/agent-pane/issues/870
[#4001]: https://github.com/copse-dev/agent-pane/issues/4001
[#4003]: https://github.com/copse-dev/agent-pane/issues/4003
[#4004]: https://github.com/copse-dev/agent-pane/issues/4004
[#4005]: https://github.com/copse-dev/agent-pane/issues/4005
[#4030]: https://github.com/copse-dev/agent-pane/pull/4030
