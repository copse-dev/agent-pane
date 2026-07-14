## Problem

Copse is local-first: the Electron main process runs the agent against the user's checkout. That fits a desktop assistant but blocks:

- Always-on scheduled runs (nightly QA, weekly doc refresh).
- Webhook/event triggers (CI failed, issue labeled, chat mention).
- Fleet parallelism (coordinator + N isolated workers on large migrations).
- Team-shared knowledge approval and org analytics.

Remote agents (Cursor Cloud, Claude Managed) cover *some* offload today, but there is no Copse-native cloud runner whose sessions use the same thread/knowledge on-disk contracts.

## Proposal

**Design document only** — no implementation in this issue. Produce `docs/plans/cloud-runner.md` covering:

### Portable contracts (already local)

- Thread store: `~/.copse/workspace/<projectId>/<threadId>/` (OKF + `events.jsonl`).
- Knowledge store: `~/.copse/knowledge/<workspace>/<type>/`.
- Skills / playbooks / project rules ingestion.

Map how these sync or mount into an isolated cloud workspace per session.

### Runner architecture

- Session = VM or container with repo checkout (or worktree), agent loop, same tool surface.
- Blueprint/snapshot: reproducible env (Node version, apt packages, services) — git-backed config.
- Coordinator pattern: parent session spawns child sessions, monitors completion, merges results.

### Event ingress (later implementation)

- Webhooks, cron schedules, GitHub/Slack/Linear adapters.
- Local Copse as *client* that dispatches to cloud API vs desktop-only cron.

### Security & tenancy

- Org RBAC, secrets vault, network egress policy (extend provider-host-allowlist thinking).
- Service users for automations.

### Migration path

- What works unchanged locally.
- What requires cloud (automations, fleet, team KB approval).
- How Cursor/Claude remote agents relate (complement vs replace).

## Deliverable

- Approved design doc with explicit "local now / cloud later" phasing.
- No code changes required to close this issue.

## Related

- `docs/plans/thread-worktrees.md` (local parallelism)
- `docs/plans/knowledge-store.md`
- `docs/thread-store-format.md`
- `src/main/services/remote/` (existing remote agents)
