## Problem

The agent can commit locally (`git_commit`) but cannot push or iterate on a PR through CI feedback. Shipping work still requires manual `git push`, watching checks, and re-prompting. Copse has CI investigator tools and `gh_pr_*` write helpers, but no closed loop from "changes made" → "PR green".

## Proposal

**Guarded PR shipping loop** for agent-driven work:

### `git push` (approval-gated)

- New tool or extended `git_commit` flow: push current branch to `origin`.
- Always prompts (hard-external in `shell-scope` today); never auto-run.
- Optional remember-grant per remote/branch pattern.

### CI feedback loop

- After push (or on existing PR): poll `wait_for_ci_checks` / `get_ci_failure_logs`.
- On failure: feed logs to CI investigator subagent; propose fix; repeat until green or user stops.
- Integrate with `track_long_task` terminal condition: "CI checks pass on PR #N".

### PR creation

- When branch has no PR: `gh pr create` (approval-gated) with title/body from thread summary.
- Link PR back to thread (extend `remote-agent-link-store` pattern for local-agent PRs).

### UX

- Shipping status card in thread: pushed ✓, PR #N, checks pending/failed/green.
- "Ship" action in overflow menu: push + open/create PR + watch CI.

## Safety

- Push and PR create stay behind explicit approval.
- No force-push tool.
- Decline push → agent can still commit locally.

## Acceptance criteria

- Agent can push and open a PR with user approval on a test repo.
- CI failure triggers investigator and surfaces fix proposal without silent retry loops.
- Unit tests for shipping state machine; e2e optional with mock `gh`.

## Related

- #558 — long-horizon tasks (grind-until-green)
- `src/main/services/security/shell-scope.ts` (`git push` = external)
- `src/main/tools/github-tools.ts`, CI investigator
- `docs/plans/long-horizon-tasks.md`
