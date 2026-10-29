# Automation PR maintenance tools

Task brief, base revision `b6de65bce`.

Unattended PR repair currently falls back to shell approval for publishing repaired
branches. Add dedicated `git_push`, `gh_pr_merge`, `gh_pr_comment`, and
`gh_pr_resolve_review_thread` tools and individual schedule-scoped grants in the
existing automation permission catalogue.

Acceptance criteria:

- A schedule can explicitly opt into each action for its project repository.
- Ordinary calls still prompt; Blocked, Always ask, read-only mode, and tool hooks
  retain their authority. General shell access is not an automation grant.
- Push targets only origin and one named branch. Rewritten history requires an
  explicit expected remote SHA, passed as a pinned force-with-lease; no bare force.
- Merge requires an expected head SHA and uses repository merge policy, without
  administrator bypass. GitHub must enforce the head guard at the mutation.
- Comments use structured text arguments. Review-thread resolution verifies that
  the thread belongs to the addressed PR and repository before mutation.
- Native and ACP callers use the same permission-gated tools.

Validation: focused service and permission tests, actual Git lease rejection tests,
automation editor WebdriverIO assertions and screenshots, then `pnpm run check`.
The local implementation adds the four tools, exact schedule grants, ACP bridge
exposure, and container exclusions. The three PR maintenance actions currently
require the host GitHub CLI; registry bootstrap does not expose them in token-only
mode. Existing API-backed lifecycle tools are unchanged.

Completion evidence (uncommitted patch):

- `git diff --check`: passed.
- Node syntax checks of the maintenance service, its tests, and tool definitions:
  passed; these are not TypeScript or behavioral validation.
- Offline and network-enabled `prepare_worktree` calls each timed out after
  300 seconds. Preflight reported absent dependencies, Node 24.22.1 against the
  24.20.0 pin, and pnpm 10.34.5. No unit, static gate, build, or visual result is
  claimed. No commit, push, or PR merge was performed for this patch.

Next steps after successful worktree preparation:

1. Run focused tests for `pr-maintenance-service`, `git-service`, `permission-gate`,
   `automation-service`, and `guest-tools`; fix any failures.
2. Run the formatter and oracle, then the required full `pnpm run check` gate.
3. Build and run `tests/e2e/settings-automations.e2e.ts` through the supported
   WebdriverIO workflow; inspect `settings-automation-push-grant.png` and the
   affected existing captures. The spec saves and reopens the selected grant.
4. Review the complete diff, rebase onto the current base, and publish only after
   validation. General shell approval remains outside the schedule grant.
